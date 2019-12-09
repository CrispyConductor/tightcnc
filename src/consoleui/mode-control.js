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

		const makeOnlyAxesFlags = (trueVal = true, falseVal = false, defVal = undefined) => {
			let flags = undefined;
			if (this.onlyAxes) {
				flags = [];
				for (let i = 0; i < this.consoleui.axisLabels.length; i++) flags[i] = falseVal;
				for (let axisNum of this.onlyAxes) flags[axisNum] = trueVal;
			} else if (defVal !== undefined) {
				flags = [];
				for (let i = 0; i < this.consoleui.usedAxes.length; i++) {
					if (this.consoleui.usedAxes[i]) {
						flags.push(defVal);
					} else {
						flags.push(falseVal);
					}
				}
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
				case 'goOrigin':
					await this.consoleui.client.op('move', {
						pos: makeOnlyAxesFlags(0, null, 0)
					});
					break;
				case 'probe':
					await this.consoleui.client.op('waitSync', {});
					let probePos = [];
					for (let axisNum = 0; axisNum < this.consoleui.axisLabels.length; axisNum++) probePos.push(null);
					probePos[params.axis] = this.consoleui.lastStatus.controller.pos[params.axis] + params.mult * this.moveIncrement;
					this.consoleui.showTempMessage('Probing ...');
					let probeTripped = true;
					try {
						await this.consoleui.client.op('probe', {
							pos: probePos,
							feed: params.feed
						});
					} catch (err) {
						if (err && err.code === 'probe_not_tripped') {
							probeTripped = false;
						} else {
							throw err;
						}
					}
					if (probeTripped) {
						this.consoleui.showTempMessage('Probe successful.');
					} else {
						this.consoleui.showTempMessage('Probe not tripped.');
					}
					break;
				case 'operation':
					await this.consoleui.client.op(params.name, params.params);
					break;
				case 'sendTextbox':
					this.box.append(this.sendBoxBorder);
					this.sendTextbox.focus();
					this.consoleui.render();
					break;

				default:
					throw new Error('Unknown keybind action ' + key);
			}
		}
	}

	_refreshText() {
		let content = '{bold}Machine Control{/bold}';
		content += '\nMove Increment: ' + this.moveIncrement + ' ' + (this.consoleui.lastStatus.controller.units || '');
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
		text.setIndex(10);
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

		this.sendBoxBorder = blessed.box({
			top: '50%-2',
			left: '25%',
			width: '50%',
			height: 3,
			border: {
				type: 'line'
			}
		});
		this.sendTextbox = blessed.textbox({
			inputOnFocus: true,
			height: 1,
			width: '100%'
		});
		this.sendBoxBorder.append(this.sendTextbox);
		this.sendBoxBorder.setIndex(100);

		this.sendTextbox.on('cancel', () => {
			this.sendTextbox.clearValue();
			this.box.remove(this.sendBoxBorder);
		});

		this.sendTextbox.on('submit', () => {
			let line = this.sendTextbox.getValue();
			this.sendTextbox.clearValue();
			this.box.remove(this.sendBoxBorder);
			this.consoleui.render();
			if (line.trim()) {
				this.consoleui.client.op('send', {
					line: line
				})
					.then(() => {
						this.consoleui.showTempMessage('Line sent.');
					})
					.catch(handleError);
			}
		});

	}

}

module.exports = ModeControl;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('control', new ModeControl(consoleui));
};

