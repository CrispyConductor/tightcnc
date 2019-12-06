const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeControl extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.keybinds = consoleui.config.consoleui.control.keybinds;
		this.moveIncrement = 1;
	}

	async _executeKeybind(action) {
		if (Array.isArray(action)) {
			for (let el of action) await this._executeKeybind(action);
			return;
		}

		for (let key in action) {
			let params = action[key];
			switch (key) {
				case 'exitMode':
					this.consoleui.exitMode();
					break;
				case 'realTimeMove':
					await this.consoleui.client.op('realTimeMove', { axis: params.axis, inc: params.mult * this.moveIncrement });
					break;
				case 'inc':
					let newInc = this.moveIncrement * params.mult;
					if (newInc > 1000 || newInc < 0.0001) break;
					this.moveIncrement = +newInc.toFixed(4);
					this._refreshText();
					break;
				case 'setOrigin':
					await this.consoleui.client.op('setOrigin', {});
					this.consoleui.showTempMessage('Origin set.');
					break;
				default:
					throw new Error('Unknown keybind action ' + key);
			}
		}
	}

	_refreshText() {
		this._centerTextBox.setContent('Machine Control\nMove Increment: ' + this.moveIncrement + ' ' + (this.consoleui.lastStatus.units || ''));
		this.consoleui.screen.render();
	}

	init() {
		super.init();
		let text = blessed.box({
			top: '50%',
			width: '100%',
			height: '100%',
			content: '',
			align: 'center'
		});
		this.box.append(text);
		this._centerTextBox = text;
		this.consoleui.registerHomeKey([ 'c', 'C' ], 'c', 'Control Mode', () => this.consoleui.activateMode('control'));

		const handleError = (err) => this.consoleui.clientError(err);

		this._refreshText();

		// Register keybinds
		const registerKeybind = (kb) => {
			this.registerModeKey(kb.keys, kb.keyNames, kb.label, () => {
				this._executeKeybind(kb.action)
					.catch(handleError);
			});
		};
		for (let key in this.keybinds) {
			registerKeybind(this.keybinds[key]);
		}

	}

}

module.exports = ModeControl;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('control', new ModeControl(consoleui));
};

