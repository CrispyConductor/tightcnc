# TightCNC

TightCNC is a CNC controller interface application with a focus on backend robustness and stability.  The architecture
is based around a solid, flexible backend that is frontend-agnostic; and a framework for easily writing interactive
gcode filters and processors (such as tool change, autolevel, etc).  The two included frontends are an interactive
console-based UI and a command-line interface.

Its features include:

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

To clone from git: `git clone https://github.com/crispy1989/tightcnc.git`  After cloning, `cd` into the directory and: `npm install`

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


## ConsoleUI Usage

The console ui is a key-driven interface that primarily uses hotkeys to navigate.  The available hotkeys for the current mode are displayed at
the bottom of the screen, along with brief notes about what each does.  The escape key is usually used to "go back", cancel, or exit the mode.

### Screen Layout

At the bottom of the screen is the hint box, which displays hints for currently available keys and what they do.

Just above the hint box is the message bar.  It contains the most recent message received from the server, error messages, various status messages, etc.

To the right is the main pane, and its contents change depending on the current mode.  In most modes its screen space is rather underused on large monitor sizes.

To the left is the status bar.  It contains current status information about the machine and the server.  The status bar is divided into sections:

* Machine: A few important pieces of status information about the machine and controller.
* Pos: The current position of the machine in both the current coordinate system and machine coordinates.
* State: Miscellaneous state information about the machine.
* Job: Current job state and progress information.

Additionally, certain actions will cause overlay dialogs to pop up which can be interacted with.

### Home Screen

The home screen is pretty much blank except for a splash message.  It is the launching point to get to the different
modes.

In addition to the job modes listed below, the home screen also contains the 'recover job' function (see the section on job recovery).

If an interactive component on the server has requested user input and has been minimized, the `i` key will appear and will
be highlighted.  In this case, hitting `i` will activate the minimized request for user input.

### Control Mode

Hitting `c` on the home screen goes to control mode.  This mode provides the ability to manually control the machine in real time (for example, jogging).
There are quite a few keybinds in this mode.  The keybinds can be edited in the config file to customize it according to your needs (eg. to remap axes, or add macros).  Additional keybinds
can also be configured for custom functions.

Several functions in this mode (including jogging) operate using an increment distance value (defaulting to 1mm).  The current increment is displayed
on the screen.  The + and - keys can be used to adjust it.

Here are the functions with default keybinds:

* Arrow keys: Jog X (left/right) and Y (up/down) axes.  Each keypress moves by one increment.  Holding the key will repeat at a maximum feed rate.
* PgUp/PgDn: Jog Z.
* +/-: Increase/decrease the increment.
* x/y/z: Hitting one of these keys causes the next operation to only apply to the given axis (if relevant to the operation).  More than one can be selected at a time.  The currently selected axes are displayed on screen.  For example, hitting the sequence "x y h" will home the X and Y axes but not Z.
* o: Set origin of current coordinate system to current position.
* h: Run the machine homing sequence.
* m: Set machine home (origin) to current position.
* g: Go to origin position.
* p: Probe downward on Z up to increment distance.  Stops and reports back if probe trips.
* ,: Feed hold.
* .: Resume from feed hold.
* /: Cancel current operations and wipe machine queue.
* Enter: Send a gcode line to the machine.  Pops up a textbox; enter the gcode to send and hit Enter again.
* Del: Reset machine.
* c: Run maCro.  Pops up a dialog to select the macro, and then to select parameters.

### Log Mode

Hitting `l` on the home screen enters log mode.  This mode displays traffic to and from the device, as well as messages from the server.  It also contains a text box to
send lines to the controller.  Type and hit Enter to send.

### New Job Mode

Hitting `n` on the home screen enters new job mode.  This mode allows you to configure and run jobs.  The current job configuration is displayed on screen, as well as results from a job dry run (if available).

Jobs can either be sourced from a file or a generator macro.  Hit `u` to upload a file from your local machine, or `f` to select a file already uploaded.  Hit `g` to use a generator macro (a dialog will be displayed to select the generator and parameters).

The `o` key is used to select job options.  This is where you can find tool change and autolevel options.  These pop up dialogs with configuration for each option.

The `r` key will reset the current job configuration and start with a new one.

Hit `d` to "dry run" the job, doing all software processing, but not actually going to the machine.  Doing a dry run will cause estimated timing and bounding box
information to be displayed.  Depending on job size and host specs, this could take a few minutes.  The `y` key also performs a dry run, but outputs the
processed gcode to a file.  Hitting `y` will pop up a dialog to enter the filename to save to.

The `s` key will start the job.  A dry run is automatically performed before actually starting the job, so it might take a few minutes (depending on job size and host specs).
After the job has been started, it will automatically switch over to job info mode.

### Job Info Mode

Hitting `j` on the home screen goes to job info mode.  This mode displays detailed information about current job progress.  This is also where
interactive job functions such as tool change, job stops, and feed override are used.  Hotkeys for these functions will appear when they are available.

This mode also pulls in the keybinds for feed hold, resume, and cancel, from the control mode keybind configuration.  This ensures that feed hold can be
easily reached.  Cancellation (either from here, or from control mode) cancels the current job and flushes any queues.

### Automatic Job Recovery

Warning: Ensure the job recovery configuration is completely correct before using job recovery!

Jobs run through the console UI automatically have recovery tracking enabled.  This saves job progress and machine state periodically, and enables restarting
the job where it left off in the event of a crash or other malfunction.  When a job successfully completes, the recovery file is removed.  This also works
on job cancellation, so if you need to temporarily interrupt a job, you can cancel it, then resume it later.

In the event of a crash/cancellation/etc, the job can be recovered by hitting `r` on the home screen.  This will ask you how many seconds to "back up",
which "rewinds" the job that number of seconds before resuming.  This can be used for cases like tool breakage where some amount of the job needs
to be retraced.  Note that this amount of time is calculated on the simulated machine, so will only be accurate if time estimates are.  Additionally,
the job is backed up a little bit further than the specified time to account for any possible uncertainty in the recovery point.

When `r` is pressed, the recovery job is started (which includes a dry run, which can take a few minutes in some cases).  Before running any job
gcode, gcode is sent to the machine to reinstate the machine state at the point of recovery.  The properties synchronized include: Motion mode, feed rate, arc plane, incremental mode, inverse feed mode, units, spindle state (direction, speed, running), coolant state (mist, flood), selected tool.

Additionally, the machine has to move to the recovery point.  This is not done directly, but instead follows a clearance path, to avoid collisions with the workpiece.
This is done by executing two macros specified in the config file: one to move to the clearance position, and one to move from the clearance
position to the workpiece to start recovery.  The parameter `pos` (along with the corresponding `x`, `y`, `z`) is passed to these macros and contains the recovery position.
Ensure these macros are correct before using job recovery, it it could end in expected machine behavior.  See the macros section for more detail on customizing them.
The default configuration assumes a typical x, y, z configuration where machine Z=0 is the max height (and the clearance position), and the controller supports G53.
It basically sends `G53 G0 Z0` to the controller then maneuvers to the recovery position.  If this does not work for you, you will need to modify
these configuration macros.

The default macros and other configuration options can be found in the [config defaults](https://github.com/crispy1989/tightcnc/blob/master/tightcnc-defaults.conf.js).

Note that the stats and progress information on recovery jobs only pertains to the section of the job that is actually run.  Ie, the progress percentage displayed
will always start at 0%.

### Autolevel

Autoleveling uses a probe to map out raised areas on a surface, then adjusts job gcode to account for surface warpage.  The TightCNC autoleveling
implementation has a few extra features:

* The probing process takes advantage of existing predicted data to minimize probe clearance and speed up the probing process while still maintaining a safe clearance.
* Each point can be probed multiple times and averaged to ensure an accurate result.
* Long moves are automatically split up into segments and autoleveled separately so that long linear moves will actually follow surface contours.
* (TinyG Specific): Includes "soft" fixes for the bugs in the current stable TinyG firmware probe feature, ensuring reliable operation across coordinate systems.

Autoleveling is accessed as a job option in new job mode.  An existing surface map file from a past run may be selected, or a new one can be created.  To
create a new surface map, select 'Create New' in the surface map selection dialog.  Options for the surface map are displayed.  Most options have defaults,
but bounds must be selected (either by entering manually, or inferring from the job, which triggers a dry run).  Once the options have been configured,
select 'Run Surface Map' to begin the process.

Make sure your probing setup is working before you start this process.  The probe can be tested in control mode.

### Tool Change

This option will intercept tool change gcode M6 and T, as well as job stop gcodes M0 and M1.

In the case of a job stop, gcode transmission to the machine
is suspended, and once the already-sent gcode finishes executing, a message will be displayed indicating that the job is stopped.  A key can then be
pressed to resume from the stop.

In the case of a tool change, a few additional things happen:

1. Spindle and coolant are turned off
2. The pre-toolchange macro is executed (typically this would move the machine to a tool-change position)
3. Wait for manual tool change and confirmation
4. The user can configure a tool length offset by hitting `t` in job info mode.  Further gcode lines are adjusted for this offset.
5. The post-toolchange macro is executed and provided the position to move back to (typically this will move to just above the resume position)
6. Spindle and coolant are re-enabled with appropriate options if necessary
7. A dwell is executed to allow the spindle to spin up; the duration is the max of dwell durations seen thus far in the job
8. The machine is moved back to the resume position and resumes the job

Make sure these macros are configured properly before using this feature.  You can find an example in the [config defaults](https://github.com/crispy1989/tightcnc/blob/master/tightcnc-defaults.conf.js)
and details about macros in the macro section.

Tool change handling is enabled as a job option in new job mode.

### Live Feed Rate Multiplier

Hit `f` in job info mode to specify a feed rate multiplier.  The runtime modification gcode processor minimizes the buffer between itself and the controller, but some
buffer is necessary for speedy operation.  Depending on the size of the buffer and the duration of the gcode lines being executed, the feed override may take
time to take effect.



## Command Line Interface Usage

If installed globally, the CLI should be available through the `tightcnc` command.  If checked out from git, it can be found in `./bin/cli.js`.  Either way, the options to it are the same.
The `--format` option is available for all subcommands.  It configures the format of the output of the command, and can take the values 'text' (default), 'json', and 'jsonpretty'.

* `tightcnc status` will print out current machine and job status information.
* `tightcnc hold`, `tightcnc resume`, and `tightcnc cancel` all perform their corresponding operations.
* `tightcnc send` sends a line of gcode to the server.
* `tightcnc op` sends an arbitrary operation request to the server and prints the result.
* `tightcnc upload` uploads a gcode file.
* `tightcnc job` starts a new job or dry run.

These commands can be listed with `tightcnc --help`.  Usage information for each subcommand can be listed with `tightcnc <subcommand> --help`.

Examples:

```
tightcnc status --format jsonpretty

tightcnc send G0X50Y30

tightcnc op probe -p pos='[ null, null, -2 ]' -p feed=45

tightcnc job -f myfile.nc -p recoverytracker:recoverySaveInterval=10
```


## Server Communications Log

TightCNC will automatically store a log of all communications with the device and some additional log information.  This can be very useful for debugging issues with
the device.  The log is stored across several files which are automatically rotated to minimize disk usage.  Settings for this rotation are in the config file.


## Macros

TightCNC includes a macro system capable of being used independently, as part of a job, or as a source for job gcode (called a generator).  Macros are written
in javascript and executed in the TightCNC context, and as such are considered privileged code (ie, don't run macros from untrusted sources).  For security
reasons, macros cannot currently be edited via the API, and must be edited on disk on the server.  It's possible this could change in the future.  Macros
should be placed in the tightcnc macros directory, and must end in `.js`.

Example basic macro (moves in a circle):

```
for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 100) {
	push('G0 X' + Math.cos(angle) + ' Y' + Math.sin(angle));
}
```

### Shorthand Macros

Macros in the config file can be specified either as a macro name (which is translated to a filename in the macros directory) or as a shorthand macro.  Shorthand
macros are arrays of strings which are simply sent as gcode lines in order.  These string can also contain parameter substitutions in the form of ES6 string
interpolation.  For example, a shorthand macro substituting for parameters might look like: `[ "G0 Z10", "G0 X${x} Y${y}" ]`

### Macro Environment

The macro javascript code is executed in a context with the following available:

* Any parameters supplied.  Parameters can be accessed by name as "raw" variables.  Parameters that look like position arrays (short arrays of numbers) are additionally augmented by adding the properties 'x', 'y', and 'z' (or whatever the axis letters are) for easy access to these values.  The special parameter `pos` is also automatically deconstructed and the variables `x`, `y`, and `z` become available, corresponding to the components of `pos`.
* `push(gcode)`: Outputs the gcode line.  If the macro is running independently, the line is immediately executed.  If run as part of a job, it is pushed into the gcode processor chain for the job.  The parameter to `push` can be a string, an instance of `GcodeLine`, or an array of words in a format accepted by the GcodeLine constructor.  If a macro is intended to be used as a generator and can generate large amounts of gcode, you should call this as `await push(gcode);`.  This will allow backpressure to be exerted on the macro.
* `await sync()`: This waits until the machine has stopped and all buffers have emptied.
* `await op(opname, params)`: This runs an operation and returns the result.
* `await runMacro(macroName, params)`: Runs another macro.
* `await input(prompt, schema)`: Prompt the user for input via the UI.  See 'User Input` below.
* `message(msg)`: Send a message to the UI to be displayed.
* `tightcnc`: A reference to the TightCNCServer object.
* `controller`: A reference to the Controller object.  For example, `controller.getPos()` returns the current machine position (as an array).
* `axisLabels`: An array of the labels that correspond to axis numbers.  This is typically something like `[ 'x', 'y', 'z' ]`.
* `XError`, `GCodeLine`: References to these classes in they they're needed.
* `macroMeta(obj)`: Specify macro metadata.  See below.

### Macro Parameters

Macros can be configurable and can accept parameters.  Parameters are specified using the `macroMeta()` function.  This function call must be before any other code in the file; any code above (or inside) it will not have access to the macro environment.

Example:

```
macroMeta({
	params: {
		speed: {
			type: 'number',
			default: 5000,
			description: 'The speed'
		},
		startPosition: {
			type: [ 'number' ],
			isCoordinates: true,
			description: 'Starting coords'
		}
	}
});

message('The speed was set to ' + speed);
message('Moving to starting position');
push('G0 X' + startPosition.x + ' Y' + startPosition.y);
```

Parameters are specified in [common schema format](https://www.npmjs.com/package/common-schema).

Additionally, there may be cases that you want to merge in another macro's parameters with your macro's (typically when calling that macro and allowing the user to define the params).
To do this, add a `mergeParams` option to `macroMeta()` containing an array of macro names to pull additional parameters from.

### Generator Macros

Generator macros are just ordinary macros that are intended to be used to generate gcode for a job.  They must start with `generator-` to mark them as generators.  In general,
calls to `push()` in a generator should be called with `await` to prevent filling up memory with large amounts of generated gcode.

### Included Macros







