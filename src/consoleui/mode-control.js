const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeControl extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.keybinds = consoleui.config.consoleui.control.keybinds;
		this.moveIncrement = 1;
		this.onlyAxes = null;
	}

	async _executeKeybind(action) {
		if (Array.isArray(action)) {
			for (let el of action) await this._executeKeybind(action);
			return;
		}

		const makeOnlyAxesFlags = () => {
			let flags = undefined;
			if (this.onlyAxes) {
				flags = [];
				for (let i = 0; i < this.consoleui.axisLabels.length; i++) flags[i] = false;
				for (let axisNum of this.onlyAxes) flags[axisNum] = true;
			}
			this.onlyAxes = null;
			this._refreshText();
			return flags;
		};

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
				case 'onlyAxis':
					if (!this.onlyAxes) this.onlyAxes = [];
					if (this.onlyAxes.indexOf(params.axis) !== -1) {
						this.onlyAxes = this.onlyAxes.filter((a) => a !== params.axis);
					} else {
						this.onlyAxes.push(params.axis);
						this.onlyAxes.sort();
					}
					if (!this.onlyAxes.length) this.onlyAxes = null;
					this._refreshText();
					break;
				case 'setOrigin':
					await this.consoleui.client.op('setOrigin', {
						pos: makeOnlyAxesFlags()
					});
					this.consoleui.showTempMessage('Origin set.');
					break;
				case 'home':
					this.consoleui.showTempMessage('Homing ...');
					await this.consoleui.client.op('home', {
						axes: makeOnlyAxesFlags()
					});
					this.consoleui.showTempMessage('Homing complete.');
					break;
				case 'setMachineHome':
					await this.consoleui.client.op('setAbsolutePos', {
						pos: makeOnlyAxesFlags()
					});
					this.consoleui.showTempMessage('Machine home set.');
					break;

				default:
					throw new Error('Unknown keybind action ' + key);
			}
		}
	}

	_refreshText() {
		let content = '{bold}Machine Control{/bold}';
		content += '\nMove Increment: ' + this.moveIncrement + ' ' + (this.consoleui.lastStatus.units || '');
		if (this.onlyAxes) {
			content += '\nNext command axes: ' + this.onlyAxes.map((axisNum) => this.consoleui.axisLabels[axisNum].toUpperCase()).join(', ');
		}
		this._centerTextBox.setContent(content);
		this.consoleui.screen.render();
	}

	init() {
		super.init();
		let text = blessed.box({
			top: '50%',
			width: '100%',
			height: '100%',
			content: '',
			align: 'center',
			tags: true
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

