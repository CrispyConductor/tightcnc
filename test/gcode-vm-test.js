const GcodeLine = require('../lib/gcode-line');
const GcodeVM = require('../lib/gcode-processors/gcode-vm');

/*
let testGcode = [
	'G54',
	'G10 P1 L2 X10 Y10 Z-10',
	'F10',
	'G1 X0 Y0 Z0'
];
*/

let testGcode = [
	'G0 Z15',
	'X10 Y10',
	'Z5',
	'X20 Y20'
];

let vm = new GcodeVM();
vm.initProcessor();
for (let str of testGcode) {
	console.log('>>>>> ' + str);
	let line = new GcodeLine(str);
	line = vm.processGcode(line);
	console.log('Before:');
	console.log(line.before);
	console.log('After:');
	console.log(line.after);
	console.log('Is Motion: ' + line.isMotion);
	console.log('');
}


