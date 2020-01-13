class LoggerMem {

	constructor(config = {}) {
		this.linesToKeep = config.size || 5000;
		this.shiftBatchSize = config.shiftBatchSize || Math.ceil(this.linesToKeep / 10);
		this.lines = [];
		this.nextNum = 1;
	}

	log(type, msg) {
		if (msg === undefined) {
			// single argument given - log raw line
			msg = type;
		} else {
			// 2 arguments given, a type and a message
			if (typeof msg !== 'string') msg = JSON.stringify(msg);
			if (type === 'send') msg = '> ' + msg;
			else if (type === 'receive') msg = '< ' + msg;
			else msg = '@ ' + msg;
			msg = msg.trim();
		}

		this.lines.push([ this.nextNum, msg ]);
		this.nextNum++;
		if (this.lines.length >= this.linesToKeep + this.shiftBatchSize) {
			this.lines = this.lines.slice(this.lines.length - this.linesToKeep);
		}
	}

	clear() {
		this.lines = [];
		this.nextNum = 1;
	}

	section(start, end, limit) {
		if (start === null || start === undefined) start = 0;
		if (start < 0) start = this.nextNum + start;
		if (start > this.nextNum) {
			// Assume that server has restarted and client hasn't caught up.  Return the desired number of lines, up to the end of our buffer.
			if (end === null || end === undefined) {
				if (!limit) return this.lines;
				else return this.lines.slice(-limit);
			} else if (end <= start) {
				return [];
			} else {
				let numRequested = end - start;
				if (limit && limit < numRequested) numRequested = limit;
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
		if (endIdx - startIdx > limit) startIdx = endIdx - limit;
		return this.lines.slice(startIdx, endIdx);
	}

}

module.exports = LoggerMem;

