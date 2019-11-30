const Controller = require('./controller');
const SerialPort = require('@serialport/stream');
const XError = require('xerror');
const pasync = require('pasync');

class TinyGController extends Controller {

	constructor(config = {}) {
		super(config);
		this.serial = null; // Instance of SerialPort stream interface class
		this.sendQueue = []; // Queue of data lines to send
		this.linesToSend = 0; // Number of lines we can currently reasonably send without filling the receive buffer
		this.responseWaiterQueue = []; // Queue of pasync waiters to be resolved when responses are received to lines; indexes match those of this.sendQueue
		this.responseWaiters = []; // pasync waiters for lines currently "in flight" (sent and waiting for response)
	}

	initConnection() {
		return new Promise((resolve, reject) => {
			// Set up options for serial connection.  (Set defaults, then apply configs on top.)
			let serialOptions = {
				autoOpen: true,
				baudRate: 115200,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				rtscts: false,
				xany: true
			};
			for (let key in this.config) {
				if (key in serialOptions) {
					serialOptions[key] = this.config[key];
				}
			}
			let port = this.config.port || '/dev/ttyUSB0';

			// Callback for when open returns
			const serialOpenCallback = (err) => {
				if (err) {
					reject(new XError(XError.COMM_ERROR, 'Error opening serial port', err));
					return;
				}

				// Set up serial port communications handlers
				this._setupSerial();
				
				// Initialize connection

				// Set ready to true
				
				// Resolve promise
				resolve();
			};

			// Open serial port, wait for callback
			this.serial = new SerialPort(port, serialOptions, serialOpenCallback);
		});
	}

	// Send as many lines as we can from the send queue
	_doSend() {
		if (this.linesToSend < 1 || this.sendQueue.length < 1) return;
		while (this.linesToSend >= 1 && this.sendQueue.length >= 1) {
			this._sendImmediate(this.sendQueue.shift(), this.responseWaiterQueue.shift());
		}
	}

	// Add a line to the send queue.  Return a promise that resolves when the response is received.
	_sendWaitResponse(line) {
		let waiter = pasync.waiter();
		this.sendQueue.push(line);
		this.responseWaiterQueue.push(waiter);
		this._doSend();
		return waiter.promise;
	}

	// Immediately send a line to the device, bypassing the send queue
	_sendImmediate(line, responseWaiter = null) {
		line = line.trim();
		// Check if should decrement linesToSend (if not !, %, etc)
		if (line === '!' || line === '%' || line === '~') {
			this.serial.write(line);
			if (responseWaiter) responseWaiter.reject(new XError(XError.INVALID_ARGUMENT, 'Cannot wait for response on control character'));
		} else {
			this.serial.write(line + '\n');
			this.linesToSend--;
			this.responseWaiters.push(responseWaiter);
		}
	}

	// Push a line onto the send queue to be sent when buffer space is available
	send(line) {
		this.sendQueue.push(line);
		this.responseWaiterQueue.push(null);
		this._doSend();
	}

	_handleReceiveSerialDataLine(line) {
		if (line[0] != '{') throw new XError(XError.PARSE_ERROR, 'Errror parsing received serial line', { data: line });
		let data = JSON.parse(line);
		if ('r' in data) {
			// Update the send buffer stats and try to send more data
			this.linesToSend++;
			let responseWaiter = this.responseWaiters.shift();
			if (responseWaiter) responseWaiter.resolve(data);
			this._doSend();
		}
	}

	_setupSerial() {
		const handlePortClosed = () => {
			// TODO: Retry opening it
		};

		this.serial.on('error', (err) => {
			this.emit('error', new XError(XError.COMM_ERROR, 'Serial port error', err));
			handlePortClosed();
		});

		this.serial.on('close', () => {
			handlePortClosed();
		});

		let receiveBuf = '';
		this.sendQueue = [];
		this.responseWaiterQueue = [];
		this.responseWaiters = [];
		this.linesToSend = 4;

		this.serial.on('data', (buf) => {
			let str = receiveBuf + buf.toString('utf8');
			let strlines = str.split(/[\r\n]+/);
			if (!strlines[strlines.length-1].trim()) {
				// Received data ended in a newline, so don't need to buffer anything
				strlines.pop();
				receiveBuf = '';
			} else {
				// Last line did not end in a newline, so add to buffer
				receiveBuf = strlines.pop();
			}
			// Process each received line
			for (let line of strlines) {
				line = line.trim();
				if (line) {
					try {
						this._handleReceiveSerialDataLine(line);
					} catch (err) {
						this.emit('error', err);
					}
				}
			}
		});
	}

};

module.exports = TinyGController;

