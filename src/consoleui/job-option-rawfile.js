const JobOption = require('./job-option');
const blessed = require('blessed');
const ListForm = require('./list-form');

class JobOptionRawfile extends JobOption {

	
	/**
	 * This method is called when the option is selected in the job creation UI.  It
	 * should handle any configuration for the option.
	 *
	 * @method optionSelected
	 */
	async optionSelected() {
		let form = new ListForm(this.consoleui);
		this.rawFile = await form.showEditor(null, { type: 'boolean', label: 'Raw File Sending Enabled' }, !!this.rawFile);
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

