// Frostybot core module

const fs = require('fs');
var context = require('express-http-context');
var cidrcheck = require("ip-range-check");
const axios = require('axios')

// Methods exported to the API

const api_methods = {

    gui: [
        'enable',
        'disable',
        'main',
        'register',
        'login',
        'auth_callback',
        'verify_recaptcha',
        'content',
        'data',
        'chart',
    ],

}

const frostybot_module = require('./mod.base')

module.exports = class frostybot_core_module extends frostybot_module {


    // Constructor

    constructor() {
        super()
    }

    // Check if IP address is local to the cluster

    async is_cluster_local_ip(ip) {
        var clusterips = await this.mod.status.clusterips();
        return clusterips.includes(ip);        
    }

    // Get proxies

    async get_proxies() {
        var proxy = await this.mod.config.get('core:proxy', '');
        return (proxy != '' ? proxy : '');
    }

    // Get port

    async port() {
        const portfile = (__dirname).replace('/core','') + '/.port';
        var port = 80
        try {
          var port = fs.readFileSync(portfile, {encoding:'utf8', flag:'r'}) 
        } catch {
          var port = (process.env.FROSTYBOT_PORT || 80);
        } 
        return port;       
    }

    // Get loopback URL

    async url() {
        var port = await this.port();
        var defval = 'http://localhost:' + port.toString();
        var url = await this.mod.config.get('core:url', defval);
        return url;
    }

    // Get remote IP address

    async remote_ip(req) {
        var proxy = await this.get_proxies();
        var proxies = proxy.split(',')
        var remoteAddress = req.socket.remoteAddress.replace('::ffff:','').replace('::1, ','');
        //var proxydetected = (Array.isArray(proxies) && proxies.includes(remoteAddress)) ? true : false;
        var proxydetected = cidrcheck(remoteAddress, proxies);
        var ip = ((proxydetected ? req.headers['x-forwarded-for'] : false) || req.socket.remoteAddress).replace('::ffff:','').replace('::1, ','');
        if (await this.is_cluster_local_ip(ip)) {
            var ip = '<cluster>';
        }
        context.set('srcIp', ip);
        var reqId = context.get('reqId')
        if (!proxydetected)
            this.mod.output.debug('source_ip', [ip, reqId]);
        return ip;
    }

    // Verify if access is allowed using a valid token or whitelist

    async verify_access(ip, uuid, token, params) {
        var command = params != undefined && params.hasOwnProperty('body') && params.body.hasOwnProperty('command') ? params.body.command : null;
        context.set('command', command)
        var core_uuid = await this.mod.encryption.core_uuid();
        var token_uuid = token != null && token.hasOwnProperty('uuid') ? token.uuid : null;
        var param_uuid = uuid;
        var localhost = ['127.0.0.1','::1','<cluster>'].includes(ip);
        var isgui = token != null;
        var isapi = !isgui;
        var multiuser = await this.mod.user.multiuser_isenabled();
        var verified = token != null ? await this.mod.user.verify_token(token) : false;
        var uuid = null;

        var all_ip_allowed = [
            'gui:main',
            'gui:login',
            'gui:logo',
            'gui:register',
            'gui:verify_recaptcha',
            'gui:content',
            'gui:chart',
            'user:register',
            'user:login',
            'signals:send',
        ]

        //console.log({isgui: isgui, isapi : isapi, localhost: localhost, param_uuid: param_uuid, multiuser: multiuser, token_uuid: token_uuid, verified: verified})

        if (!localhost && isapi && multiuser && param_uuid == null && !all_ip_allowed.includes(command)) {
            await this.mod.output.error('required_param', ['uuid']);
            return false;
        }

        if (isgui && all_ip_allowed.includes(command)) {
            return true;
        }

        if (isgui && !verified) {
            await this.mod.output.error('invalid_token');
            return false;
        }

        if (localhost && isapi && param_uuid == null) {
            this.mod.output.debug('access_local_core')
            uuid = core_uuid;
            context.set('uuid', uuid);
            return (all_ip_allowed.includes(command) ? true : await this.mod.whitelist.verify(ip));
        }

        if (isgui && verified) {
            this.mod.output.debug('access_gui_token')
            uuid = token_uuid;
            context.set('uuid', uuid);
            return true;
        }

        if (isapi && multiuser && param_uuid != null) {
            uuid = param_uuid;
            this.mod.output.debug('access_api_uuid')
            context.set('uuid', uuid);
            return (all_ip_allowed.includes(command) ? true : await this.mod.whitelist.verify(ip));
        }
            
        if (!localhost && isapi && multiuser && param_uuid == null && token_uuid == null) {
            //uuid = core_uuid;
            this.mod.output.debug('access_api_core')
            //context.set('uuid', uuid);
            return (all_ip_allowed.includes(command) ? true : await this.mod.whitelist.verify(ip));
        }

        if (isapi && !multiuser && param_uuid == null) {
            uuid = core_uuid;
            this.mod.output.debug('access_api_core')
            context.set('uuid', uuid);
            return (all_ip_allowed.includes(command) ? true : await this.mod.whitelist.verify(ip));
        }

        if (isapi && !multiuser && param_uuid != null) {
            uuid = param_uuid;
            this.mod.output.debug('access_api_uuid')
            context.set('uuid', uuid);
            return (all_ip_allowed.includes(command) ? true : await this.mod.whitelist.verify(ip));
        }

        return false;

    }

    // Parse request

    parse_request(request) {
        // Single pre-parsed command parameter
        if (request.body.hasOwnProperty('command')) return request.body;
        // Multiple pre-parsed command parameters
        if (this.mod.utils.is_array(request.body) && request.body[0].hasOwnProperty('command')) return request.body;
        // Raw request body
        return this.parse_raw(request.rawBody);
    }
    

    // Parse raw text into parameter object

    parse_raw(text) {
        var lines = (text.trim() + '\n').split('\n');
        var commands = [];
        for (var l = 0; l < lines.length; l++) {
            var line = lines[l];
            if (line.trim() != '') {
                var params = line.split(' ').filter(part => part.toLowerCase() != 'frostybot');
                var paramObj = {};
                if (Array.isArray(params)) {
                    var command = false;
                    for(var i = 0; i < params.length; i++) {
                        var param = params[i].trim();
                        if (param.toLowerCase() != 'frostybot') {  // In case user included the "frostybot" in the webhook command
                            if ((param.indexOf('=') < 0) && param.indexOf(':') >= 0 && (command == false)) {
                                command = true;
                                param = 'command='+param;
                            }
                            var [key, val] = param.split('=');
                            paramObj[key] = val;
                        } 
                    }
                    commands.push(paramObj);
                }    
            }
        }
        return (commands.length == 1 ? commands[0] : commands);
    }

    // Parse Command Parameter Object

    parse_obj(params) {
        params = this.mod.utils.clean_object(params);      
        var command = this.mod.utils.extract_props(params, 'command').toLowerCase();
        if (command == undefined) 
            return this.mod.output.error('required_param', ['command']);
        if (command.indexOf(':') < 0) 
            return this.mod.output.error('malformed_param', ['command']);
        var parts = command.split(':');
        var numparts = parts.length;
        if (this.mod.utils.is_array(parts) && parts.length > 1) {
            var mod = parts[0];
            var cmd = parts.slice(1).join(':');
            if (cmd.indexOf(':') > 0) {                 // Check if stub is included in the command
                var [stub, cmd] = cmd.split(':');
                params['stub'] = stub;
            }
            if ((numparts == 2) && (global.frostybot.methodmap.trade.includes(cmd)) && (!['trade','exchange'].includes(parts[0]))) {
                // "trade:" was excluded from the command, add it
                var stub = mod;
                var mod = "trade";
                params['stub'] = stub;
                this.mod.output.debug('trade_cmd_shortcut', [stub.toLowerCase(), cmd.toLowerCase()]);
            }
        } else {
            return this.mod.output.error('malformed_param', ['command']);
        }
        delete params.command;
        params = this.mod.utils.uppercase_values(params, ['symbol', 'mapping']);
        params = this.mod.utils.lowercase_values(params, ['stub']);
        return [mod, cmd, params];
    }


    // Check if module exists and initialize it

    load_module(module) {
        if (global.frostybot.modules[module] != undefined) {
            this.mod[module] = global.frostybot.modules[module];
            return true;
        }
        return false;
    }


    // Check if a given method exists in a given module

    method_exists(module, method) {
        return global.frostybot.methodmap[module].includes(method)
    }
    

    // Execute Frostybot Command(s)

    async execute(request, raw = null) {
        this.mod.output.reset();
        var params = this.parse_request(request);
        if (this.mod.utils.is_object(params) && params.hasOwnProperty('0') && params['0'].hasOwnProperty('command')) {
            params = Object.values(params);
        }
        if (this.mod.utils.is_array(params)) {                          
            var results = await this.execute_multiple(params, raw);  // Multiple commands submitted
        } else {        
            var results = await this.execute_single(params, raw);     // Single command submitted
        }
        return results;
    }


    // Execute Multiple Commands

    async execute_multiple(multi_params, raw) {
        var results = [];
        if (this.mod.utils.is_object(multi_params)) {
            multi_params = Object.values(multi_params)
        }
        for (var i = 0; i < multi_params.length; i++) {
            var params = multi_params[i];
            if (this.mod.utils.is_object(params)) {
                var result = await this.execute_single(params, raw);
                results.push(result);    
            }
        }
        return await this.mod.output.combine(results);
    }

    // Execute a Single Command
    
    async execute_single(params, raw) {
        var parsed = this.parse_obj(params);
        if (parsed.length == 3) {
            var [module, method, params] = parsed;
            context.set('command', module + ':' + method);
            this.mod.output.section('executing_command', [module, method]);
            this.mod.output.notice('executing_command', [module, method]);
            //this.mod.output.notice('command_params', [{ ...{ command: module + ":" + method}, ...(this.mod.utils.remove_props(params,['_raw_'])) }]);
            var cmdparams = { ...{ command: module + ":" + method}, ...params };
            if (cmdparams.hasOwnProperty('_loopbacktoken_')) delete cmdparams['_loopbacktoken_']
            this.mod.output.notice('command_params', [cmdparams]);
            if (this.load_module(module)) {
                //this.mod.output.debug('loaded_module', module)    
                var method = this.mod.utils.is_array(method.split(':')) ? method.split(':')[0] : method;
                if (params.hasOwnProperty('uuid')) {
                    context.set('uuid', params.uuid);
                }

                if (this.method_exists(module, method)) {

                    // Check permissions to execute 
                    var permissionset = await this.mod.settings.get('core', 'permissionset', 'standard');
                    if (!['standard','provider'].includes(permissionset))
                        permissionset = 'standard';
                    var checkpermissions = await this.mod.permissions.check(permissionset, { ...{ command: module + ":" + method}, ...params })
                    if (!checkpermissions)
                        return await this.mod.output.parse(this.mod.output.error('permissions_denied', [permissionset, module + ":" + method]));

                    // Start execution
                    var start = (new Date).getTime();

                    // If no symbol is supplied, use the default symbol
                    if (module != 'symbolmap' && !params.hasOwnProperty('symbol') && params.hasOwnProperty('stub')) {
                        var exchangeid = this.mod.accounts.get_exchange_from_stub(params.stub);
                        if (exchangeid !== false) {
                            var mapping = await this.mod.symbolmap.map(exchangeid, 'DEFAULT');
                            if (mapping !== false) {
                                this.mod.output.notice('symbol_mapping', [exchangeid, 'default', mapping])
                                params.symbol = mapping;
                            } 
                        }
                    }

                    // If stub is supplied, and not adding a new stub, make sure the account exists
                    if (params.hasOwnProperty('stub') && !(module == 'accounts' && method == 'add')) {
                        var stub = params.stub.toLowerCase()
                        if (this.mod.accounts.getaccount(stub) === false) {
                            return await this.mod.output.parse(this.mod.output.error('unknown_stub', stub))
                        } 
                        params.stub = stub
                        context.set('stub', stub);
                    }

                    // Check for symbol mapping and use it if required, verify that market exists
                                /*
                    if (module != 'symbolmap' && (params.hasOwnProperty('symbol') || params.hasOwnProperty('tvsymbol')) && params.hasOwnProperty('stub')) {
                        var exchangeid = await this.mod.accounts.get_exchange_from_stub(params.stub);
                        if (exchangeid !== false) {
                            var exchange = new this.classes.exchange(stub);
                            if (exchange != undefined) {

                                // Check if TradingView syminfo.tickerid supplied in tvsymbol parameter
                                var tvsymbol = !params.hasOwnProperty('symbol') && params.hasOwnProperty('tvsymbol') ? params.tvsymbol : null;
                                if (tvsymbol !== null) {
                                    let result = await exchange.execute(stub, 'market', {tvsymbol: tvsymbol.toUpperCase()});
                                    if (result instanceof this.classes.market) {
                                        var symbol = result.symbol;
                                        this.mod.output.notice('tvsymbolmap_map', [exchangeid, tvsymbol, symbol]);
                                        params.symbol = symbol;
                                        delete params.tvsymbol;
                                    } else {
                                        return this.mod.output.error('tvsymbolmap_map', [tvsymbol]);
                                    }
                                }

                                // Check for symbolmap and use it if configured
                                var mapping = await this.mod.symbolmap.map(exchangeid, params.symbol);
                                if (mapping !== false) {
                                    this.mod.output.notice('symbol_mapping', [exchangeid, params.symbol, mapping])
                                    params.symbol = mapping.toUpperCase();
                                }
                                params.symbol = params.symbol.toUpperCase();
                            
                                // Check that market symbol is valid

                                let result = await exchange.execute(stub, 'market', {symbol: params.symbol});
                                if (this.mod.utils.is_empty(result)) {
                                    return await this.mod.output.parse(this.mod.output.error('unknown_market', params.symbol));
                                }
                            }
                        }
                    }

                                */
                    if (params.hasOwnProperty('uuid')) delete params.uuid;
                    if (raw !== null) 
                        params['_raw_'] = raw;
                    var result = null;
                    try {
                        result = await global.frostybot.modules[module][method](params);
                    } catch (e) {
                        this.mod.output.exception(e);
                        result = false;
                    }
                    var end = (new Date).getTime();
                    var duration = (end - start) / 1000;            
                    this.mod.output.notice('command_completed', duration);
                    return await this.mod.output.parse(result);

                } else {
                    return await this.mod.output.parse(this.mod.output.error('unknown_method', method));  
                }
            } else {
                return await this.mod.output.parse(this.mod.output.error('unknown_module', (module == 'this' ? 'Invalid format' : module)));  
            }
        }
        return await this.mod.output.parse(this.mod.output.error('malformed_param', parsed));
    } 



}