var async = require('async'),
    Resource = require('./Resource'),
    EventEmitter2 = require('eventemitter2').EventEmitter2;

/**
 * Manages the state and loading of multiple resources to load.
 *
 * @class
 * @param baseUrl {string} The base url for all resources loaded by this loader.
 * @param [concurrency=10] {number} The number of resources to load concurrently.
 */
function Loader(baseUrl, concurrency) {
    EventEmitter2.call(this);

    concurrency = concurrency || 10;

    /**
     * The base url for all resources loaded by this loader.
     *
     * @member {string}
     */
    this.baseUrl = baseUrl || '';

    /**
     * The progress percent of the loader going through the queue.
     *
     * @member {number}
     */
    this.progress = 0;

    /**
     * Loading state of the loader, true if it is currently loading resources.
     *
     * @member {boolean}
     */
    this.loading = false;

    /**
     * The percentage of total progress that a single resource represents.
     *
     * @member {number}
     */
    this._progressChunk = 0;

    /**
     * The middleware to run before loading each resource.
     *
     * @member {function[]}
     */
    this._beforeMiddleware = [];

    /**
     * The middleware to run after loading each resource.
     *
     * @member {function[]}
     */
    this._afterMiddleware = [];

    /**
     * The `loadResource` function bound with this object context.
     *
     * @private
     * @member {function}
     */
    this._boundLoadResource = this.loadResource.bind(this);

    /**
     * The `_onComplete` function bound with this object context.
     *
     * @private
     * @member {function}
     */
    this._boundOnComplete = this._onComplete.bind(this);

    /**
     * The resource buffer that fills until `load` is called to start loading resources.
     *
     * @private
     * @member {Resource[]}
     */
    this._buffer = [];

    /**
     * The resources waiting to be loaded.
     *
     * @member {Resource[]}
     */
    this.queue = async.queue(this._boundLoadResource, concurrency);

    /**
     * All the resources for this loader keyed by name.
     *
     * @member {object<string, Resource>}
     */
    this.resources = {};

    /**
     * Emitted once per loaded or errored resource.
     *
     * @event progress
     */

    /**
     * Emitted once per errored resource.
     *
     * @event error
     */

    /**
     * Emitted once per loaded resource.
     *
     * @event load
     */

    /**
     * Emitted when the loader begins to process the queue.
     *
     * @event start
     */

    /**
     * Emitted when the queued resources all load.
     *
     * @event complete
     */
}

Loader.prototype = Object.create(EventEmitter2.prototype);
Loader.prototype.constructor = Loader;
module.exports = Loader;

/**
 * Adds a resource (or multiple resources) to the loader queue.
 *
 * @alias enqueue
 * @param name {string} The name of the resource to load.
 * @param url {string} The url for this resource, relative to the baseUrl of this loader.
 * @param [options] {object} The options for the load.
 * @param [options.crossOrigin] {boolean} Is this request cross-origin? Default is to determine automatically.
 * @param [options.loadType=Resource.LOAD_TYPE.XHR] {Resource.XHR_LOAD_TYPE} How should this resource be loaded?
 * @param [options.xhrType=Resource.XHR_RESPONSE_TYPE.DEFAULT] {Resource.XHR_RESPONSE_TYPE} How should the data being
 *      loaded be interpreted when using XHR?
 * @param [callback] {function} Function to call when this specific resource completes loading.
 * @return {Loader}
 */
Loader.prototype.add = Loader.prototype.enqueue = function (name, url, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = null;
    }

    if (this.resources[name]) {
        throw new Error('Resource with name "' + name + '" already exists.');
    }

    // create the store the resource
    this.resources[name] = new Resource(name, this.baseUrl + url, options);

    if (typeof cb === 'function') {
        this.resources[name].once('afterMiddleware', cb);
    }

    // if already loading add it to the worker queue
    if (this.queue.started) {
        this.queue.push(this.resources[name]);
        this._progressChunk = (100 - this.progress) / (this.queue.length() + this.queue.running());
    }
    // otherwise buffer it to be added to the queue later
    else {
        this._buffer.push(this.resources[name]);
        this._progressChunk = 100 / this._buffer.length;
    }

    return this;
};


/**
 * Sets up a middleware function that will run *before* the
 * resource is loaded.
 *
 * @alias pre
 * @param middleware {function} The middleware function to register.
 * @return {Loader}
 */
Loader.prototype.before = Loader.prototype.pre = function (fn) {
    this._beforeMiddleware.push(fn);

    return this;
};

/**
 * Sets up a middleware function that will run *after* the
 * resource is loaded.
 *
 * @alias use
 * @param middleware {function} The middleware function to register.
 * @return {Loader}
 */
Loader.prototype.after = Loader.prototype.use = function (fn) {
    this._afterMiddleware.push(fn);

    return this;
};

/**
 * Resets the queue of the loader to prepare for a new load.
 *
 * @return {Loader}
 */
Loader.prototype.reset = function () {
    this._buffer.length = 0;

    this.queue.kill();
    this.queue.started = false;

    this.progress = 0;
    this._progressChunk = 0;
    this.loading = false;
};

/**
 * Starts loading the queued resources.
 *
 * @fires start
 * @param [callback] {function} Optional callback that will be bound to the `complete` event.
 * @return {Loader}
 */
Loader.prototype.load = function (cb) {
    // register complete callback if they pass one
    if (typeof cb === 'function') {
        this.once('complete', cb);
    }

    // if the queue has already started we are done here
    if (this.queue.started) {
        return this;
    }

    // set drain event callback
    this.queue.drain = this._boundOnComplete;

    // notify of start
    this.emit('start', this);

    // start the internal queue
    for (var i = 0; i < this._buffer.length; ++i) {
        this.queue.push(this._buffer[i]);
    }

    // empty the buffer
    this._buffer.length = 0;

    return this;
};

/**
 * Loads a single resource.
 *
 * @fires progress
 */
Loader.prototype.loadResource = function (resource, cb) {
    var self = this;

    this._runMiddleware(resource, this._beforeMiddleware, function () {
        // resource.on('progress', self.emit.bind(self, 'progress'));
        resource.once('complete', self._onLoad.bind(self, resource, cb));

        resource.load();
    });
};

/**
 * Called once each resource has loaded.
 *
 * @fires complete
 * @private
 */
Loader.prototype._onComplete = function () {
    this.emit('complete', this, this.resources);
};

function _mapQueue(obj, res) {
    obj[res.name] = res;

    return obj;
}

/**
 * Called each time a resources is loaded.
 *
 * @fires progress
 * @fires error
 * @fires load
 * @private
 */
Loader.prototype._onLoad = function (resource, cb) {
    this.progress += this._progressChunk;

    this.emit('progress', this, resource);

    if (resource.error) {
        this.emit('error', resource.error, this, resource);
    }
    else {
        this.emit('load', this, resource);
    }

    this._runMiddleware(resource, this._afterMiddleware, function () {
        resource.emit('afterMiddleware', resource);

        cb && cb();
    });
};

/**
 * Run middleware functions on a resource.
 *
 * @private
 */
Loader.prototype._runMiddleware = function (resource, fns, cb) {
    var self = this;

    async.eachSeries(fns, function (fn, next) {
        fn.call(self, resource, next);
    }, cb.bind(this, resource));
};

Loader.LOAD_TYPE = Resource.LOAD_TYPE;
Loader.XHR_READY_STATE = Resource.XHR_READY_STATE;
Loader.XHR_RESPONSE_TYPE = Resource.XHR_RESPONSE_TYPE;