const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeHome extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.homeKeys = [];
		this.firstHomeActivate = true;
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
		if (this.firstHomeActivate) {
			this.firstHomeActivate = false;
			for (let homeKey of this.homeKeys) {
				this.box.key(homeKey.keys, homeKey.fn);
			}
		}
		super.activateMode();
	}

	exitMode() {
		super.exitMode();
	}

	registerHomeKey(keys, keyNames, keyLabel, fn, order = 1000) {
		this.registerModeHint(keyNames, keyLabel, order);
		if (!Array.isArray(keys)) keys = [ keys ];

		let pos = this.homeKeys.length;
		for (let i = 0; i < this.homeKeys.length; i++) {
			if (this.homeKeys[i].order > order) {
				pos = i;
				break;
			}
		}

		this.homeKeys.splice(pos, 0, { keys, keyNames, keyLabel, fn, order });
	}

}

module.exports = ModeHome;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('home', new ModeHome(consoleui));
};

