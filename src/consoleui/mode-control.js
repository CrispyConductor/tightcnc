const ConsoleUIMode = require('./consoleui-mode');
const blessed = require('blessed');

class ModeControl extends ConsoleUIMode {

	constructor(consoleui) {
		super(consoleui);
		this.moveIncrement = 1;
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
		this.consoleui.registerHomeKey([ 'c', 'C' ], 'c', 'Control Mode', () => this.consoleui.activateMode('control'));
		this.registerModeKey('escape', 'Esc', 'Home', () => this.consoleui.exitMode());

		const handleError = (err) => this.consoleui.clientError(err);
		const refreshText = () => {
			text.setContent('Machine Control\nMove Increment: ' + this.moveIncrement + ' ' + (this.consoleui.lastStatus.units || ''));
			this.consoleui.screen.render();
		};

		refreshText();

		this.registerModeKey([ 'left', 'a', 'A' ], [ 'Left', 'a' ], 'X-', () => {
			this.consoleui.client.op('realTimeMove', { axis: 0, inc: -this.moveIncrement }).catch(handleError);
		});

		this.registerModeKey([ 'right', 'd', 'D' ], [ 'Right', 'd' ], 'X+', () => {
			this.consoleui.client.op('realTimeMove', { axis: 0, inc: this.moveIncrement }).catch(handleError);
		});

		this.registerModeKey([ 'down', 's', 'S' ], [ 'Down', 's' ], 'Y-', () => {
			this.consoleui.client.op('realTimeMove', { axis: 1, inc: -this.moveIncrement }).catch(handleError);
		});

		this.registerModeKey([ 'up', 'w', 'W' ], [ 'Up', 'w' ], 'Y+', () => {
			this.consoleui.client.op('realTimeMove', { axis: 1, inc: this.moveIncrement }).catch(handleError);
		});

		this.registerModeKey([ 'pagedown', 'f', 'F' ], [ 'PgDn', 'f' ], 'Z-', () => {
			this.consoleui.client.op('realTimeMove', { axis: 2, inc: -this.moveIncrement }).catch(handleError);
		});

		this.registerModeKey([ 'pageup', 'r', 'R' ], [ 'PgUp', 'r' ], 'Z+', () => {
			this.consoleui.client.op('realTimeMove', { axis: 2, inc: this.moveIncrement }).catch(handleError);
		});

		this.registerModeKey([ '-' ], [ '-' ], 'Inc-', () => {
			this.moveIncrement /= 10;
			refreshText();
		});

		this.registerModeKey([ '+', '=' ], [ '+' ], 'Inc+', () => {
			this.moveIncrement *= 10;
			refreshText();
		});

		this.registerModeKey([ 'o', 'O' ], [ 'o' ], 'Set Origin', () => {
			this.consoleui.client.op('setOrigin', {}).then(() => this.consoleui.showTempMessage('Origin set.'), handleError);
		});

	}

}

module.exports = ModeControl;
module.exports.registerConsoleUI = function(consoleui) {
	consoleui.registerMode('control', new ModeControl(consoleui));
};

