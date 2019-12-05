const blessed = require('blessed');

class ConsoleUIMode {

	constructor(consoleui) {
		this.consoleui = consoleui;
		this.modeHints = [];
		this.activeModeHints = [];
	}

	/**
	 * Called once all modes have been registered, in registration order.
	 */
	init() {
		this.box = blessed.box({
			width: '100%',
			height: '100%'
		});
	}

	/**
	 * Registers a hint to be automatically activated when the mode is activated, and deactivated when the mode is exited.
	 */
	registerModeHint(keyNames, label) {
		this.modeHints.push({ keyNames, label });
	}

	registerModeKey(keys, keyNames, keyLabel, fn) {
		this.registerModeHint(keyNames, keyLabel);
		this.box.key(keys, fn);
	}

	/**
	 * Called by ConsoleUI() as part of mode activation.  Responsible for filling consoleui.mainPane.
	 */
	activateMode() {
		for (let modeHint of this.modeHints) {
			let hint = this.consoleui.addHint(modeHint.keyNames, modeHint.label);
			this.activeModeHints.push(hint);
		}
		this.consoleui.mainPane.append(this.box);
		this.box.focus();
	}

	/**
	 * Called by ConsoleUI when the mode is exited.  Must clean up after the mode.
	 */
	exitMode() {
		for (let hint of this.activeModeHints) {
			this.consoleui.removeHint(hint);
		}
		this.activeModeHints = [];
		this.consoleui.mainPane.remove(this.box);
	}

}

module.exports = ConsoleUIMode;

