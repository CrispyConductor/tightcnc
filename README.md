# TightCNC

TightCNC is a CNC controller interface application, with a focus on backend robustness and stability.  Its features include:

* Support for arbitrary axes
* Autoleveling using a surface probe, with a few special features
* Failed/interrupted job recovery, as in the case of a power outage
* Plugin system allowing external extensions
* A powerful macro system using javascript, capable of interacting with both the controller and user (via the ui) in real time
* A framework designed for pluggable gcode transforms that can analyze and modify gcode live (eg. used to implement job recovery, autoleveling, etc.)
* Completely API-driven for independence from any particular UI.  A key-driven terminal interface is included (no mouse required).
* Includes a command-line utility for shell scripting
* Keeps an automatically rotating log of all recent communication with the device for debugging purpose
* Both server and bundled console UI can run on a raspberry pi
* Supports arbitrary file sizes, files are never loaded into memory all at once
* Includes a framework for building automatic parameterized gcode generators, based on the macro system
* Runtime feed override
* Supports multiple simultaneous clients
* Currently supports TinyG, but includes a controller abstraction layer for future implementation of other controllers
* For TinyG, uses an algorithm to estimate a gcode line's position in various queues and buffers, allowing for advanced flow control and extra progress feedback
* Fast gcode sender supporting short, fast moves while still ensuring immediate operations such as feed hold/cancel are immediately effective

TightCNC is not designed to be an all-in-one CAD/CAM/Sender package; it is strictly focused on post-CAM processing and machine interfacing.  Nearly all operations
are handled server-side, so things like UI crashes are not an issue for ongoing jobs.

## Supported Devices

Currently, support for different types of devices is lacking - only TinyG (and probably g2core, but not tested) is supported (because that's the
only device I have to test with).  If others have any interest in this project, and would be willing to help test implementations on
their machines, I plan to build support for additional types of devices.

The TinyG implementation is itself pretty complete, and takes advantage of several of this device's special features (the recommended
abbreviated JSON syntax, triple queue reports for flow control, etc).


## Setup

### Install Node.JS

You can install node through the instructions [here](https://nodejs.org/en/download/package-manager/) for your platform.

### Install TightCNC

To install the current published version from npm: `$ npm install -g tightcnc`

To clone from git: `git clone https://github.com/crispy1989/tightcnc.git`

### Configure TightCNC

Create a file called `tightcnc.conf`, copied from [tightcnc.conf-example](https://github.com/crispy1989/tightcnc/blob/master/tightcnc.conf-example).  This file can
be located in the package root directory (the git checkout directory if cloned from git, or `node_modules/tightcnc/` if installed from npm), or in `/etc`.  You
can also specify the location of the configuration file by setting the environment variable `TIGHTCNC_CONFIG` to the path of the config file, including filename.

Open the config file and add/edit options as needed.  The server will not start until it finds the configuration file.  Proper configuration is critical for safe operation.
In addition to editing the options found in the example configuration, take a look at the [config defaults](https://github.com/crispy1989/tightcnc/blob/master/tightcnc-defaults.conf.js) file for a more complete list of options.  Also
check the options for any plugins you plan to use.

The same configuration file is used for both the client and the server, but most of the options are only relevant to the server.  To run the client on
a separate machine, set up the configuration on the client machine as well.  The main client settings are `host` and `authKey`, but there are some
consoleui-specific options as well.

### Permissions

The server process will need to be able to access the serial port.  On Linux, this can be accomplished either by running the server as root (not recommended),
or by giving the user access to the serial port.  On many Linux systems, the command `sudo usermod -a -G serial <username>` will work.


## Running

### Server

To run the server, run the command `tightcnc-server`.  If running from git, you can use `./bin/tightcnc-server.js` or `npm run server`.

The server should print out "Listening on port ...", followed by "Controller ready." when connected over serial.  If there's an error
connecting, it will be printed out.  If there's an error, or the server cannot connect immediately, it will keep trying until
successful.

### Console UI

Run the console ui with `tightcnc-consoleui`, or (from git) `./bin/tightcnc-consoleui.js`.  If the server is not running,
consoleui will exit immediately.

### Command Line Interface

The command-line interface can be accessed with the command `tightcnc --help`, or (from git) `./bin/cli.js --help`.




