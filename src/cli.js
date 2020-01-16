const littleconf = require('littleconf');
const TightCNCClient = require('../lib/clientlib');
const objtools = require('objtools');
const fs = require('fs');
const path = require('path');

let config = littleconf.getConfig();
let client = new TightCNCClient(config);


require('yargs')
	.option('format', {
		string: true,
		choices: [ 'text', 'json', 'jsonpretty' ],
		default: 'text',
		desc: 'Command output format'
	})
	.command([ 'status', 'stat', 'st' ], 'Get current status information', (yargs) => {
		return yargs
			.option('field', {
				alias: 'f',
				array: true,
				desc: 'Return only this field/fields',
				requiresArg: true
			})
			.option('sync', {
				alias: 's',
				boolean: true,
				desc: 'Wait for machine to sync before returning status'
			});
	}, (argv) => {
		runCmd(cmdStatus, argv);
	})
	.command('hold', 'Feed hold', () => {}, (argv) => runCmd(cmdHold, argv))
	.command('resume', 'Resume from feed hold', () => {}, (argv) => runCmd(cmdResume, argv))
	.command('cancel', 'Cancel running operations', () => {}, (argv) => runCmd(cancel, argv))
	.command('send <line>', 'Send a gcode line', (yargs) => {
		return yargs
			.positional('line', {
				string: true,
				desc: 'Gcode line to send'
			})
			.option('sync', {
				alias: 's',
				boolean: true,
				desc: 'Wait for machine to sync before returning'
			});
	}, (argv) => {
		runCmd(cmdSend, argv);
	})
	.command('op <opname>', 'Run a given operation', (yargs) => {
		return yargs
			.positional('opname', {
				string: true,
				desc: 'Name of operation to run'
			})
			.option('param', {
				array: true,
				alias: 'p',
				desc: 'Parameter for the operation in form "PARAM=VALUE".  Can be provided more than once.',
				requiresArg: true
			})
			.option('paramsfile', {
				alias: [ 'paramfile', 'pfile' ],
				string: true,
				desc: 'Load operation parameters from json file',
				requiresArg: true
			});
	}, (argv) => {
		runCmd(cmdOp, argv);
	})
	.command('upload <file>', 'Upload a file', (yargs) => {
		return yargs
			.positional('file', {
				string: true,
				desc: 'Filename'
			})
			.option('name', {
				alias: 'n',
				string: true,
				desc: 'Remote name for the file',
				requiresArg: true
			});
	}, (argv) => {
		runCmd(cmdUpload, argv);
	})
	.command('job', 'Start a job', (yargs) => {
		return yargs
			.option('file', {
				alias: 'f',
				string: true,
				desc: 'Remote filename of job gcode source file',
				requiresArg: true
			})
			.option('generator', {
				alias: 'g',
				string: true,
				desc: 'Generator name to use as job source.  Supply parameters in form: <generator>:param1=value1:param2=value2:...',
				requiresArg: true
			})
			.option('dryrun', {
				alias: 'd',
				boolean: true,
				desc: 'Do a job dry run instead of to the machine'
			})
			.option('outputfile', {
				alias: 'o',
				string: true,
				desc: 'Output dry run results to this (remote) filename',
				requiresArg: true
			})
			.option('processor', {
				alias: 'p',
				string: true,
				desc: 'Use gcode processor, can be specified more than once.  In form: <processorname>:param1=value1:param2=value2:...',
				requiresArg: true
			});
	}, (argv) => {
		runCmd(cmdJob, argv);
	})
	.demandCommand()
	.help()
	.argv;

function runCmd(fn, argv) {
	fn(argv)
		.then((r) => (r !== undefined) && outputValue(r, argv.format))
		.catch((err) => { outputError(err, argv.format); process.exit(1); });
}

function outputValue(value, format = 'text') {
	if (format === 'json') {
		console.log(JSON.stringify(value));
	} else if (format === 'jsonpretty') {
		console.log(JSON.stringify(value, null, 4));
	} else {
		const outputValueText = (value, indent, path) => {
			const outputStr = (s) => {
				let str = '';
				for (let i = 0; i < indent; i++) str += '    ';
				if (path) str += path + ': ';
				str += s;
				console.log(str);
			};
			if (value === undefined) {
				return;
			} else if (value === null) {
				outputStr('null');
			} else if (Array.isArray(value)) {
				outputStr('[array ' + value.length +  ']');
				for (let i = 0; i < value.length; i++) {
					outputValueText(value[i], indent + 1, path ? (path + '.' + i) : ('' + i));
				}
			} else if (typeof value === 'object') {
				outputStr('[object]');
				for (let key in value) {
					outputValueText(value[key], indent + 1, path ? (path + '.' + key) : key);
				}
			} else {
				outputStr(value.toString());
			}
		};
		outputValueText(value, 0, '');
	}
}

function outputError(err, format = 'text') {
	if (format === 'json' || format === 'jsonpretty') {
		console.log(JSON.stringify({
			error: {
				code: err.code,
				message: err.message
			}
		}, null, (format === 'jsonpretty') ? 4 : null));
	} else {
		console.log('Error: ' + err.message);
		//if (err.stack) console.log(err.stack);
		console.log(err);
	}
}


async function cmdJob(argv) {
	if (!argv.file && !argv.generator) throw new Error('Must supply either an input filename (-f) or source generator (-g).');

	const parseOptList = (str) => {
		let parts = str.split(':');
		let key = parts.shift();
		let obj = {};
		for (let part of parts) {
			let matches = /^([^=]+)=(.*)$/.exec(part);
			if (matches) {
				let v = matches[2];
				try { v = JSON.parse(v); } catch (err) {}
				objtools.setPath(obj, matches[1], v);
			} else {
				throw new Error('Invalid param format, must be key=value');
			}

		}
		return [ key, obj ];
	};

	let jobOptions = {};
	let dryRun = false;
	if (argv.file) jobOptions.filename = argv.file;
	if (argv.generator) {
		if (!/^generator-/.test(argv.generator)) argv.generator = 'generator-' + argv.generator;
		let [ generator, generatorParams ] = parseOptList(argv.generator);
		jobOptions.macro = generator;
		jobOptions.macroParams = generatorParams;
	}
	if (argv.dryrun) {
		dryRun = true;
		if (argv.outputfile) {
			jobOptions.outputFilename = argv.outputfile;
		}
	}
	if (argv.processor) {
		let procstrs = argv.processor;
		if (!Array.isArray(procstrs)) procstrs = [ procstrs ];
		let procs = [];
		for (let pstr of procstrs) {
			let [ procname, procopts ] = parseOptList(pstr);
			procs.push({
				name: procname,
				options: procopts
			});
		}
		jobOptions.gcodeProcessors = procs;
	}

	return await client.op(dryRun ? 'jobDryRun' : 'startJob', jobOptions);
}


async function cmdStatus(argv) {
	let fields = undefined;
	if (argv.field) {
		if (Array.isArray(argv.field)) fields = argv.field;
		else fields = [ argv.field ];
	}
	let r = await client.op('getStatus', {
		fields: fields,
		sync: !!argv.sync
	});
	if (fields && fields.length === 1) {
		return objtools.getPath(r, fields[0]);
	} else {
		return r;
	}
}


async function cmdHold(argv) {
	await client.op('hold', {});
}

async function cmdResume(argv) {
	await client.op('resume', {});
}

async function cmdCancel(argv) {
	await client.op('cancel', {});
}

async function cmdSend(argv) {
	await client.op('send', {
		line: argv.line,
		wait: !!argv.sync
	});
	if (argv.sync) {
		await client.op('waitSync', {});
	}
}

async function cmdOp(argv) {
	let params = {};
	if (argv.paramsfile) {
		let json = fs.readFileSync(argv.paramsfile, { encoding: 'utf8' });
		objtools.merge(params, JSON.parse(json));
	}
	if (argv.param) {
		let aparams = argv.param;
		if (!Array.isArray(aparams)) aparams = [ aparams ];
		for (let v of aparams) {
			let matches = /^([^=]+)=(.*)$/.exec(v);
			if (matches) {
				v = matches[2];
				try { v = JSON.parse(v); } catch (err) {}
				objtools.setPath(params, matches[1], v);
			} else {
				objtools.setPath(params, v, true);
			}
		}
	}
	let r = client.op(argv.opname, params);
	return r;
}

async function cmdUpload(argv) {
	let filename = argv.file;
	let remotename = argv.name || path.basename(filename);
	if (remotename.indexOf('.') === -1) remotename += '.nc';
	let body = fs.readFileSync(filename, { encoding: 'utf8' });
	await client.op('uploadFile', {
		filename: remotename,
		data: body
	});
}



