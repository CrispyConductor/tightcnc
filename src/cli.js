const argv = require('yargs').argv;
const littleconf = require('littleconf');
const SimpleCNCClient = require('../lib/clientlib');

if (!argv.operation && !argv.o) {
	console.error('Must provide operation to execute with --operation');
	process.exit(1);
}

let operation = argv.operation || argv.o;
let params = {};
for (let key in argv) {
	if (/^[a-zA-Z]/.test(key) && key !== 'o' && key !== 'operation') {
		let value = argv[key];
		try { value = JSON.parse(value); } catch(err) {}
		params[key] = value;
	}
}

let config = littleconf.getConfig();
let client = new SimpleCNCClient(config);

client.op(operation, params)
	.then((r) => {
		console.log(JSON.stringify(r, null, 4));
	})
	.catch((err) => {
		console.error(err);
	});

