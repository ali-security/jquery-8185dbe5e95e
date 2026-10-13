#!/usr/bin/env node
/*
 * Headless-Chrome runner for jQuery's browser QUnit suite (test/index.html).
 *
 * Upstream runs this suite only in real browsers (TestSwarm); there is no
 * Node runner for it. This script serves the repository with PHP's built-in
 * server (test/data/*.php backs the ajax tests), opens test/index.html in
 * headless Chrome through puppeteer-core, prints one line per test plus a
 * summary, and exits non-zero on any failure.
 *
 * Environment:
 *   CHROME_PATH      Chrome binary (default: `google-chrome` on PATH)
 *   SEAL_PHP         php binary (default: php)
 *   SEAL_PORT        server port (default: 8000)
 *   SEAL_TEST_QUERY  query string for test/index.html (default: "dev",
 *                    i.e. load the unminified dist/jquery.js)
 *   SEAL_SKIP_TESTS  tests to de-register, separated by newlines or "|".
 *                    Each entry is "<module>: <test name>" (or a bare test
 *                    name, matched in any module). Entries that match no
 *                    declared test fail the run, so a stale exclusion
 *                    can't hide silently.
 *   SEAL_TIMEOUT_MIN overall timeout in minutes (default: 30)
 *
 * puppeteer-core is resolved through NODE_PATH so it can live outside the
 * repository's own node_modules.
 */
"use strict";

const { spawn, execFileSync } = require( "child_process" );
const http = require( "http" );
const puppeteer = require( "puppeteer-core" );

const ROOT = __dirname;
const PORT = Number( process.env.SEAL_PORT || 8000 );
const QUERY = process.env.SEAL_TEST_QUERY === undefined ? "dev" : process.env.SEAL_TEST_QUERY;
const TIMEOUT_MS = Number( process.env.SEAL_TIMEOUT_MIN || 30 ) * 60 * 1000;
const SKIP = ( process.env.SEAL_SKIP_TESTS || "" )
	.split( /[\n|]/ )
	.map( ( s ) => s.trim() )
	.filter( Boolean );
const PREFIX = "__SEAL_QUNIT__";

function chromePath() {
	if ( process.env.CHROME_PATH ) {
		return process.env.CHROME_PATH;
	}
	return execFileSync( "which", [ "google-chrome" ], { encoding: "utf8" } ).trim();
}

function waitForServer( url, deadline ) {
	return new Promise( ( resolve, reject ) => {
		const attempt = () => {
			http.get( url, ( res ) => {
				res.resume();
				resolve();
			} ).on( "error", () => {
				if ( Date.now() > deadline ) {
					reject( new Error( "PHP server did not come up at " + url ) );
				} else {
					setTimeout( attempt, 200 );
				}
			} );
		};
		attempt();
	} );
}

// Runs in every frame before any page script. Only the top frame (the
// QUnit page itself) is instrumented; fixture iframes are left alone.
function pageInstrumentation( prefix, skipList ) {
	if ( window.top !== window ) {
		return;
	}

	// Snapshot natives: some tests stub window.JSON / console methods.
	const stringify = JSON.stringify.bind( JSON );
	const log = console.log.bind( console );
	const emit = ( type, data ) => {
		try {
			log( prefix + stringify( { type, data } ) );
		} catch ( e ) {
			try {
				log( prefix + "{\"type\":\"emit-error\",\"data\":\"" +
					String( e ).replace( /["\\\n]/g, " " ) + "\"}" );
			} catch ( e2 ) {}
		}
	};
	const str = ( v ) => {
		try {
			return typeof v === "string" ? v : stringify( v );
		} catch ( e ) {
			return String( v );
		}
	};

	const skip = new Set( skipList );
	const usedSkips = new Set();
	let qunit;
	let instrumented = false;

	const instrument = ( Q ) => {
		if ( instrumented || !Q || typeof Q.test !== "function" ) {
			return;
		}
		instrumented = true;
		Q.config.reorder = false;

		const wrapDeclare = ( fnName ) => {
			const original = Q[ fnName ];
			Q[ fnName ] = function( name ) {
				const mod = Q.config.currentModule && Q.config.currentModule.name || "";
				const full = mod + ": " + name;
				const hit = skip.has( full ) ? full : skip.has( name ) ? name : null;
				if ( hit !== null ) {
					usedSkips.add( hit );
					emit( "skipped", { module: mod, name: String( name ) } );
					return undefined;
				}
				return original.apply( this, arguments );
			};
		};
		wrapDeclare( "test" );
		wrapDeclare( "asyncTest" );

		let failedAssertions = [];
		Q.moduleStart( ( d ) => emit( "moduleStart", { name: d.name } ) );
		Q.testStart( () => {
			failedAssertions = [];
		} );
		Q.log( ( d ) => {
			if ( !d.result ) {
				failedAssertions.push( {
					message: d.message === undefined ? "" : String( d.message ),
					actual: str( d.actual ),
					expected: str( d.expected ),
					source: d.source ? String( d.source ).split( "\n" ).slice( 0, 3 ).join( " | " ) : ""
				} );
			}
		} );
		Q.testDone( ( d ) => emit( "testDone", {
			module: d.module,
			name: d.name,
			failed: d.failed,
			passed: d.passed,
			total: d.total,
			runtime: d.runtime,
			assertions: failedAssertions
		} ) );
		Q.done( ( d ) => emit( "done", {
			failed: d.failed,
			passed: d.passed,
			total: d.total,
			runtime: d.runtime,
			unusedSkips: skipList.filter( ( s ) => !usedSkips.has( s ) )
		} ) );
	};

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get() {
			return qunit;
		},
		set( v ) {
			qunit = v;
			instrument( v );
		}
	} );
}

async function main() {
	const url = "http://127.0.0.1:" + PORT + "/test/index.html" + ( QUERY ? "?" + QUERY : "" );
	const deadline = Date.now() + TIMEOUT_MS;

	let finished = false;
	const php = spawn( process.env.SEAL_PHP || "php",
		[ "-S", "127.0.0.1:" + PORT, "-t", ROOT ], {
			cwd: ROOT,

			// A single-process server starves the iframe/ajax fixtures.
			env: Object.assign( {}, process.env, { PHP_CLI_SERVER_WORKERS: "10" } ),
			stdio: [ "ignore", "ignore", "ignore" ]
		} );
	php.on( "exit", ( code ) => {
		if ( !finished ) {
			console.error( "PHP server exited early with code " + code );
			process.exit( 1 );
		}
	} );

	await waitForServer( "http://127.0.0.1:" + PORT + "/test/index.html", Date.now() + 30000 );

	const browser = await puppeteer.launch( {
		executablePath: chromePath(),
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--window-size=1280,1024"
		],
		defaultViewport: { width: 1280, height: 1024 }
	} );

	const shutdown = async( code ) => {
		finished = true;
		try {
			await browser.close();
		} catch ( e ) {}
		php.kill();
		process.exit( code );
	};

	const page = await browser.newPage();
	let tests = 0;
	let failedTests = 0;
	let excluded = 0;
	const failures = [];

	const result = new Promise( ( resolve ) => {
		page.on( "console", ( msg ) => {
			const text = msg.text();
			if ( !text.startsWith( PREFIX ) ) {
				return;
			}
			let ev;
			try {
				ev = JSON.parse( text.slice( PREFIX.length ) );
			} catch ( e ) {
				console.log( "[runner] unparsable event: " + text.slice( 0, 200 ) );
				return;
			}
			const d = ev.data;
			if ( ev.type === "moduleStart" ) {
				console.log( "\n# Module: " + d.name );
			} else if ( ev.type === "skipped" ) {
				excluded++;
				console.log( "EXCLUDED  " + d.module + ": " + d.name );
			} else if ( ev.type === "testDone" ) {
				tests++;
				const ok = d.failed === 0;
				const line = ( ok ? "ok    " : "FAIL  " ) + d.module + ": " + d.name +
					" (" + d.passed + "/" + d.total + " assertions, " + d.runtime + "ms)";
				console.log( line );
				if ( !ok ) {
					failedTests++;
					failures.push( line );
					for ( const a of d.assertions ) {
						console.log( "        - " + a.message );
						console.log( "          expected: " + a.expected );
						console.log( "          actual:   " + a.actual );
						if ( a.source ) {
							console.log( "          at: " + a.source );
						}
					}
				}
			} else if ( ev.type === "done" ) {
				resolve( d );
			} else if ( ev.type === "emit-error" ) {
				console.log( "[runner] emit error: " + d );
			}
		} );
	} );

	page.on( "pageerror", ( err ) => {
		console.log( "[page error] " + ( err && err.message || err ) );
	} );
	page.on( "dialog", ( dialog ) => dialog.dismiss() );

	await page.evaluateOnNewDocument( pageInstrumentation, PREFIX, SKIP );

	console.log( "Opening " + url );
	console.log( "Chrome: " + await browser.version() );
	await page.goto( url, { waitUntil: "load", timeout: 120000 } );

	const timer = new Promise( ( resolve ) => setTimeout( () => resolve( null ),
		deadline - Date.now() ) );
	const done = await Promise.race( [ result, timer ] );

	if ( !done ) {
		console.log( "\nTIMEOUT: suite did not finish within " + TIMEOUT_MS / 60000 +
			" minutes (" + tests + " tests reported)" );
		return shutdown( 1 );
	}

	console.log( "\nTests completed: " + tests + " tests, " + done.total + " assertions, " +
		done.failed + " failed assertions, " + failedTests + " failed tests, " +
		excluded + " excluded (" + done.runtime + "ms)" );
	if ( failures.length ) {
		console.log( "\nFailed tests:" );
		failures.forEach( ( f ) => console.log( "  " + f ) );
	}
	if ( done.unusedSkips.length ) {
		console.log( "\nExclusions that matched no declared test:" );
		done.unusedSkips.forEach( ( s ) => console.log( "  " + s ) );
	}
	const ok = done.failed === 0 && failedTests === 0 && tests > 0 &&
		done.unusedSkips.length === 0;
	return shutdown( ok ? 0 : 1 );
}

main().catch( ( err ) => {
	console.error( err && err.stack || err );
	process.exit( 1 );
} );
