class LoggerMem {

	constructor(config = {}) {
		this.linesToKeep = config.size || 5000;
		this.shiftBatchSize = config.shiftBatchSize || Math.ceil(this.linesToKeep / 10);
		this.lines = [];
		this.nextNum = 1;
	}

	log(type, msg) {
		if (typeof msg !== 'string') msg = JSON.stringify(msg);
		if (type === 'send') msg = '> ' + msg;
		else if (type === 'receive') msg = '< ' + msg;
		else msg = '@ ' + msg;
		msg = msg.trim();

		this.lines.push([ this.nextNum, msg ]);
		this.nextNum++;
		if (this.lines.length >= this.linesToKeep + this.shiftBatchSize) {
			this.lines = this.lines.slice(this.lines.length - this.linesToKeep);
		}
	}

	section(start, end) {
		if (start === null || start === undefined) start = 0;
		if (start < 0) start = this.nextNum + start;
		if (start > this.nextNum) {
			// Assume that server has restarted and client hasn't caught up.  Return the desired number of lines, up to the end of our buffer.
			if (end === null || end === undefined) {
				return this.lines;
			} else if (end <= start) {
				return [];
			} else {
				let numRequested = end - start;
				let startIdx = this.lines.length - numRequested;
				if (startIdx < 0) startIdx = 0;
				return this.lines.slice(startIdx);
			}
		}
		if (start === this.nextNum || !this.lines.length) return [];
		let linesStartNum = this.lines[0][0];
		if (start < linesStartNum) start = linesStartNum;

		if (end === null || end === undefined) end = this.nextNum;
		if (end < 0) end = this.nextNum + end;
		if (end > this.nextNum) end = this.nextNum;
		if (end <= start) return [];

		let startIdx = start - linesStartNum;
		let endIdx = end - linesStartNum;
		return this.lines.slice(startIdx, endIdx);
	}

}

module.exports = LoggerMem;

