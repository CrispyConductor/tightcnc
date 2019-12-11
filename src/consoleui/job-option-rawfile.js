const JobOption = require('./job-option');
const blessed = require('blessed');

class JobOptionRawfile extends JobOption {

	
	/**
	 * This method is called when the option is selected in the job creation UI.  It
	 * should handle any configuration for the option.
	 *
	 * @method optionSelected
	 */
	optionSelected() {
		let containerBox = blessed.box({
			width: 30,
			border: {
				type: 'line'
			},
			height: 7,
			top: 'center',
			left: 'center'
		});
		let boxTitle = blessed.box({
			width: '100%',
			height: 1,
			align: 'center',
			content: 'Send Raw File (No Analysis)'
		});
		containerBox.append(boxTitle);
		let listBox = blessed.list({
			style: {
				selected: {
					inverse: true
				},
				item: {
					inverse: false
				}
			},
			keys: true,
			items: [ 'Off', 'On' ],
			width: '100%-2',
			height: '100%-3',
			top: 1,
			border: {
				type: 'line'
			}
		});
		containerBox.append(listBox);
		listBox.select(this.rawFile ? 1 : 0);
		this.newJobMode.box.append(containerBox);
		listBox.focus();
		listBox.once('select', () => {
			this.rawFile = !!listBox.selected;
			containerBox.remove(listBox);
			this.newJobMode.box.remove(containerBox);
			this.newJobMode.updateJobInfoText();
			this.consoleui.render();
		});
		listBox.once('cancel', () => {
			containerBox.remove(listBox);
			this.newJobMode.box.remove(containerBox);
			this.consoleui.render();
		});
		this.consoleui.render();
	}

	/**
	 * This method should handle adding whatever this job option needs to the jobOptions
	 * object sent to the server.  It should use state information that was collected
	 * in optionSelected().
	 *
	 * @method addToJobOptions
	 * @param {Object} obj - jobOptions object to be sent to the server
	 */
	addToJobOptions(obj) {
		if (this.rawFile) obj.rawFile = true;
	}

	/**
	 * Return a string to append to the job configuration display.
	 *
	 * @method getDisplayString
	 * @return {String}
	 */
	getDisplayString() {
		if (!this.rawFile) return null;
		return 'Send Raw File: On';
	}

}

module.exports = JobOptionRawfile;
module.exports.registerConsoleUI = (consoleui) => {
	consoleui.registerJobOption('Send Raw File (No Analysis)', JobOptionRawfile);
};

