// Accounts Handling Module

const frostybot_module = require('./mod.base')
var context = require('express-http-context');

module.exports = class frostybot_accounts_module extends frostybot_module {

    // Constructor

    constructor() {
        super()
        this.description = 'Accounts Managememnt Module'
    }

    // Register methods with the API (called by init_all() in core.loader.js)

    register_api_endpoints() {

        // Permissions are the same for all methods, so define them once and reuse
        var permissions = {
            'standard': [ 'core,singleuser', 'multiuser,user', 'token' ],
            'provider': [ 'token' ]
        }

        // API method to endpoint mappings
        var api = {
            'accounts:get': [
                                'get|/accounts',                    // Get all account information
                                'get|/accounts/:stub',              // Get account information for specific stub
            ],
            'accounts:add':    [
                                'post|/accounts',                   // Add new account
                                'put|/accounts',                    // Update account
            ],
            'accounts:delete': 
                                'delete|/accounts/:stub',           // Delete account for specific stub
            'accounts:test':    'post|/accounts/:stub/test',        // Test API keys with the exchange
        }

        // Register endpoints with the REST and Webhook APIs
        for (const [method, endpoint] of Object.entries(api)) {   
            this.register_api_endpoint(method, endpoint, permissions); // Defined in mod.base.js
        }
        
    }


    // Get account silently (no log output, used internally)

    async getaccount(stub) {
        var account = await this.mod.settings.get('accounts', stub);
        if (account !== null) {
            return await this.mod.utils.decrypt_values( this.mod.utils.lower_props(account), ['apikey', 'secret'])
        }
        return false;
    }

    // Get stubs for a specific account uuid (no log output, used internally)

    async stubs_by_uuid(uuid, stub = undefined) {
        var query = {
                uuid: uuid,
                mainkey: 'accounts'
        }
        if (stub != undefined) query['subkey'] = stub;
        var result = await this.database.select('settings', query);
        var stubs = [];
        if (this.mod.utils.is_array(result) && result.length > 0) {
            for (var i = 0; i < result.length; i++) {
                var data = JSON.parse(result[i].value);
                stubs.push(data);
            }
        }      
        return stubs;
    }

    // Get all uuids and stubs

    async all_uuids_and_stubs() {
        return await this.uuids_and_stubs({});
    }

    // Get uuid and stubs

    async uuids_and_stubs(filter = {}) {
        var query = {
            mainkey: 'accounts'
        }
        if (filter['user'] != undefined) query['uuid'] = filter['user'];
        if (filter['stub'] != undefined) query['subkey'] = filter['stub'];
        var result = await this.database.select('settings', query);
        var stubs = {}
        if (this.mod.utils.is_array(result) && result.length > 0) {
            for (var i = 0; i < result.length; i++) {
                var uuid = result[i].uuid;
                var data = JSON.parse(result[i].value);
                if (stubs[uuid] == undefined) stubs[uuid] = [];
                stubs[uuid].push(data);
            }
        }      
        return stubs;            
    }


    // Get account(s)

    async get(params) {
        if (params == undefined) {
            params = []
        }
        var stub = this.mod.utils.extract_props(params, 'stub');
        if ([undefined, false].includes(stub)) {
            var results = await this.mod.settings.get('accounts');
            if (results) {
                var accounts = {};
                if (this.mod.utils.is_object(results)) {
                    if (results.hasOwnProperty('stub')) {
                        var stub = results.stub;
                        accounts[stub] = results;
                    } else {
                        accounts = results;
                    }
                }
                //if (!this.mod.utils.is_array(results))
                //results = results.hasOwnProperty('stub') ? [results] : results;

                //var accounts = {};
                //for(var i = 0; i < results.length; i++) 
                //    accounts[results[i].stub] = this.mod.utils.lower_props(results[i]);
                
                //this.mod.output.success('account_retrieve', [ Object.values(accounts).length + ' accounts' ]);
                return await this.censored(accounts);
            } else return false; //this.mod.output.error('account_retrieve', ['No accounts configured']);
        }  else {
            var account = await this.mod.settings.get('accounts', stub);
            if (account) {
                var accounts = {};
                accounts[stub] = this.mod.utils.lower_props(account)
                //this.mod.output.success('account_retrieve', stub);
                return this.censored(accounts);
            }
            return false; //this.mod.output.error('account_retrieve', stub);
        }
    }


    // Censor account output

    async censored(accounts) {
        var result = {};
        if (accounts != false) {
            for (var [stub, account] of Object.entries(accounts)) {
                if (account != false) {
                    account = await this.mod.utils.decrypt_values(account, ['apikey', 'secret'])
                    account = await this.mod.utils.censor_props(account, ['secret'])
                }
                result[stub] = account;
            }
            return result;
        }
    }


    // Check if account stub exists

    async exists(stub) {
        var account = await this.mod.settings.get('accounts', stub, false);
        if (account) {
            return true;
        }
        return false;
    }


    // Extract CCXT Test Parameters 

    create_params(params) {
        const stub = params.stub.toLowerCase();
        const description = params.hasOwnProperty('description') ? params.description : params.exchange;
        const exchange = params.exchange.toLowerCase();
        const type = params.hasOwnProperty('type') ? params.type : undefined;
        delete params.stub;
        delete params.description;
        delete params.exchange;
        delete params.type;
        if (params.hasOwnProperty('token')) delete params.token;
        var data = {
            description: description,
            exchange: exchange,
            type: type,
            parameters: params,
        }
        return [stub, data];
    }


    // Create new account

    async create(params) {

        var schema = {
            stub: {        required: 'string', format: 'lowercase' },
            exchange: {    required: 'string', format: 'lowercase', oneof: ['ftx', 'ftxus', 'deribit', 'binance', 'binanceus', 'bitmex'] },
            description: { optional: 'string'  },
            apikey: {      required: 'string'  },
            secret: {      required: 'string'  },
            testnet: {     optional: 'boolean' },
            subaccount: {  optional: 'string'  },
            type: {        optional: 'string', format: 'lowercase', oneof: ['spot', 'margin', 'futures', 'coinm'] },
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        if ((params.exchange == 'binance') && (!params.hasOwnProperty('type'))) {
            return this.mod.output.error('binance_req_type')
        }

        var [stub, data] = this.create_params(params);
        let testresult = await this.test(data);
        if (testresult) {
            data['stub'] = stub;
            data = await this.mod.utils.remove_props(data, ['tenant','token']);
            data = await this.mod.utils.encrypt_values(data, ['apikey', 'secret']);
            if (await this.mod.settings.set('accounts', stub, data)) {
                this.mod.output.success('account_create', stub);
                this.mod.datasources.refresh('exchange:positions', {user: context.get('uuid'), stub: stub});
                this.mod.datasources.refresh('exchange:balances', {user: context.get('uuid'), stub: stub});
                return true;
            }
            this.mod.output.error('account_create', stub);
        }
        return false;
    }


    // Alias for create

    async add(params) {
        return await this.create(params);
    }

    // Update account

    async update(params) {
        var [stub, data] = this.create_params(params);
        let testresult = await this.test(data);
        if (testresult) {
            data['stub'] = stub;
            this.mod.output.success('account_test', stub);
            data = await this.mod.utils.remove_props(data, ['tenant','token'])
            data = await this.mod.utils.encrypt_values(data, ['apikey', 'secret'])
            if (await this.mod.settings.set('accounts', stub, data)) {
                this.mod.output.success('account_update', stub);
            }
            this.mod.output.error('account_update', stub);
        }
        this.mod.output.error('account_test', stub);
        return false;
    }


    // Delete account

    async delete(params) {

        var schema = {
            stub: { required: 'string', format: 'lowercase' }
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 


        var stub = (params.hasOwnProperty('stub') ? params.stub : null);
        if (stub != null) {
            if (await this.mod.settings.delete('accounts', stub)) {
                this.mod.output.success('account_delete', stub);
                return true;
            }
        }
        this.mod.output.error('account_delete', stub);
        return false;
    }


    // Alias for delete

    async remove(params) {
        return await this.delete(params);
    }


    // Get account connection info

    async ccxtparams(account) {

        if (account.hasOwnProperty('uuid')) delete account.uuid;
        const ccxtlib = require ('ccxt');
        if (!account.hasOwnProperty('parameters')) {
            var stubs = Object.getOwnPropertyNames(account);
            if (stubs.length == 1) {
                account = account[stubs[0]];
            }
        }

        var testnet = account.parameters.hasOwnProperty('testnet') ? String(account.parameters.testnet) == "true" : false;
        var subaccount = account.parameters.hasOwnProperty('subaccount') ? account.parameters.subaccount : null;

        var result = {
            exchange: account.hasOwnProperty('exchange') ? account.exchange : null,
            description: account.hasOwnProperty('description') ? account.description : null,
            parameters: {
                apiKey:     account.parameters.hasOwnProperty('apikey') ? await  this.mod.encryption.decrypt(account.parameters.apikey) : null,
                secret:     account.parameters.hasOwnProperty('secret') ? await this.mod.encryption.decrypt(account.parameters.secret) : null,
                urls:       {},
            },   
        }
        if (['ftx','ftxus'].includes(result.exchange)) {
            result.parameters.hostname = result.exchange == 'ftx' ? 'ftx.com' : 'ftx.us';
            if (subaccount != null) {
                switch (result.exchange) {
                    case 'ftx'      :   result.parameters.headers = { 'FTX-SUBACCOUNT': subaccount }; break;
                    case 'ftxus'    :   result.parameters.headers = { 'FTXUS-SUBACCOUNT': subaccount }; break;
                }
            }
        }
        if (result.exchange == 'binance') {
            var type = (account.hasOwnProperty('type') ? account.type.replace('futures','future').replace('coinm','delivery') : 'future');
            if (!['spot', 'margin', 'future', 'delivery'].includes(type)) {
                return this.mod.output.error('param_val_oneof', ['type', this.serialize_array(['spot', 'margin', 'futures', 'coinm'])])
            } else {
                result.parameters['options'] = {
                    defaultType : type,
                };
            }
        }
        const exchangeId = account.exchange.replace('ftxus','ftx');
        const exchangeClass = ccxtlib[exchangeId];
        const ccxtobj = new exchangeClass ();
        const ccxturls = ccxtobj.urls;
        result.parameters.urls = ccxturls;
        if (testnet) {
            if (ccxturls.hasOwnProperty('test')) {
                const url = ccxturls.test;
                result.parameters.urls.api = url
            } else {
                this.mod.output.translate('warning', 'testnet_not_avail', this.mod.utils.uc_first(result.exchange));
            }
        }
        return result;
    }


    // Test account

    async test(params) {
        if (params.hasOwnProperty('stub')) {
            var account = await this.getaccount(params.stub);
        } else {
            var account = params;
        }
        const ccxtlib = require ('ccxt');
        var ccxtparams = await this.ccxtparams(account);
        const accountParams = ccxtparams.parameters;
        const exchangeId = account.exchange.replace('ftxus','ftx');
        const exchangeClass = ccxtlib[exchangeId];
        const ccxtobj = new exchangeClass (accountParams);
        try {
            let result = await ccxtobj.fetchBalance();
        } catch (e) {
            if (e.name == 'AuthenticationError') {
                this.mod.output.error('account_test');
                return false;
            }
        } 
        this.mod.output.success('account_test');
        return true;
    }


    // Get exchange ID from stub

    async get_exchange_from_stub(stub) {
        var account = await this.getaccount(stub);
        if (account !== false) {
            var ccxtparams = await this.ccxtparams(account);
            return ccxtparams.exchange;
        }
        return false;
    }


    // Get exchange shortname from stub

    async get_shortname_from_stub(stub) {
        var context = require('express-http-context');
        var uuid = context.get('uuid');
        var cachekey = uuid + ':' + stub;
        var cacheresult = this.mod.cache.get(cachekey);
        if (cacheresult == undefined) {
            var account = await this.getaccount(stub);
            if (account) {
                var result = account.exchange + (account.hasOwnProperty('type') ? '_' + account.type : '');
                this.mod.cache.set(cachekey, result, 60);
                return result;
            }
            return false;
        }
        return cacheresult;
    }

}