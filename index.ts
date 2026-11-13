// Entry point: `npm start -- <command>` compiles and runs this file.
// Everything else lives in backend/ (server side), engine/ (shared) and frontend/ (browser).
import { Cli } from './backend/cli.js';

await new Cli().run(process.argv.slice(2));
