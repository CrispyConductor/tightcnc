const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeHome extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
	}

	init() {
		super.init();
		//this.box.setContent('Home screen');
		let text = blessed.box({
			top: '50%',
			width: '100%',
			height: '100%',
			content: 'TightCNC ConsoleUI',
			align: 'center'
		});
		this.box.append(text);
		this.registerHomeKey([ 'escape', 'q' ], 'Esc', 'Exit', () => process.exit(0), 0);
	}

	activateMode() {
		super.activateMode();
	}

	exitMode() {
		super.exitMode();
	}

	registerHomeKey(keys, keyNames, keyLabel, fn, order = 1000) {
		return this.registerModeKey(keys, keyNames, keyLabel, fn, order);
	}

}

module.exports = ModeHome;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('home', new ModeHome(consoleui));
};

