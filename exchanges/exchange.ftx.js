frostybot_exchange_base = require('./exchange.base');
var context = require('express-http-context');

module.exports = class frostybot_exchange_ftx extends frostybot_exchange_base {

    // Class constructor

    constructor(stub = undefined) {
        super(stub);        
        this.ccxtmodule = 'ftx'              // CCXT module to use
        this.shortname = 'ftx'               // Abbreviated name for this exchange
        this.description = 'FTX'             // Full name for this exchange
        this.has_subaccounts = true          // Subaccounts supported?
        this.has_testnet = false             // Test supported?
        this.stablecoins = ['USD', 'USDT'];  // Stablecoins supported on this exchange
        this.order_sizing = 'base';          // Exchange requires base size for orders
        this.collateral_assets = ['BCH','BNB','BTC','BVOL','CUSDT','ETH','FTT','IBVOL','KNC','LINK','LTC','PAXG','SOL','SRM','TRX','TRYB','USD','USDT','XAUT','XRP'];  // Assets that are used for collateral
        this.balances_market_map = '{currency}/{stablecoin}'  // Which market to use to convert non-USD balances to USD
        this.doublecheck = false;            // When order is submitted, double check that it exists on the exchange
        this.param_map = {                   // Order parameter mappings
            limit             : 'limit',
            market            : 'market',
            stoploss_limit    : 'stop',
            stoploss_market   : 'stop',
            takeprofit_limit  : 'takeProfit', 
            takeprofit_market : 'takeProfit',
            trailstop         : 'trailingStop', 
            post              : 'postOnly',
            reduce            : 'reduceOnly',
            ioc               : 'ioc',
            tag               : 'clientId',
            trigger           : 'triggerPrice',
        };
        this.orders_symbol_required = false;  // When getting order history, the symbol is not required
        this.map_mod();
    }

    // Get CCXT Parameters

    ccxtparams() {
        var params = {
            hostname: 'ftx.com',
        }

        if (this.stub != undefined) {
            var stub = this.stub;
            params['apiKey'] = stub.parameters.apikey;
            params['secret'] = stub.parameters.secret;
            /*
            if (String(stub.parameters.testnet) == 'true') {
                const ccxtlib = require ('ccxt');
                const testclass = ccxtlib['ftx'];
                var testobj = new testclass ();
                var urls = testobj.urls != undefined ? testobj.urls : {};
                params['urls'] = urls;
                if (urls.hasOwnProperty('test')) params.urls.api = urls.test;
            }*/
            if (stub.parameters.subaccount != undefined) params['headers'] = { 'FTX-SUBACCOUNT': stub.parameters.subaccount };
        }
        return ['ftx', params];

    }    

    // Custom params

    custom_params(params) {
        var [type, order_params, custom_params] = params
        if (order_params.type == 'trailingStop') {
            order_params.params['trailValue'] = order_params.params.triggerPrice;
            delete order_params.params.triggerPrice;
        }
        return order_params;
    }    

    
    // Get list of current positions

    async positions() { 
        let results = await this.execute('private_get_positions', {showAvgPrice: true});
        var raw_positions = results.result;
        // Get futures positions
        var positions = []; 
        if (this.mod.utils.is_array(raw_positions)) {
            await raw_positions
            .filter(raw_position => raw_position.size != 0)
            .forEach(async raw_position => {
                const symbol = raw_position.future;
                const direction = (raw_position.side == 'buy' ? 'long' : 'short');
                const base_size = parseFloat(raw_position.size);
                const entry_price = parseFloat(raw_position.recentAverageOpenPrice);
                const liquidation_price = parseFloat(raw_position.estimatedLiquidationPrice);
                const raw = raw_position;
                const position = new this.classes.position_futures(this.stub.uuid, this.stub.stub, 'ftx', symbol, direction, base_size, null, entry_price, liquidation_price, raw);
                await position.update();
                positions.push(position)
            })
        }
        // Emulate spot "positions" against USD for non-stablecoin balances
        var balances = await this.balances();
        this.stablecoins.forEach(async (stablecoin) => {
            balances.forEach(async (balance) => {
                if (!this.stablecoins.includes(balance.currency)) {
                    const symbol = balance.currency + '/' + stablecoin;
                    const market = await this.mod.exchange.market('ftx', symbol);
                    if (market != null) {
                        const direction = 'long';
                        const base_size = parseFloat(balance.base.total);
                        const position = new this.classes.position_spot(this.stub.uuid, this.stub.stub, 'ftx', symbol, direction, base_size);
                        await position.update();
                        positions.push(position)
                    }
                }
            });
        });
        this.positions = positions;
        return this.positions;
    }

    // Get list of markets from exchange

    async markets() {
        let results = [];
        var raw_markets = await this.execute('fetch_markets');;
        var exchange = (this.shortname != undefined ? this.shortname : (this.constructor.name).split('_').slice(2).join('_'));
        if (this.mod.utils.is_array(raw_markets))
            raw_markets
            .filter(raw_market => raw_market.active == true)
            .forEach(raw_market => {
                const id = raw_market.id;
                const symbol = raw_market.symbol;
                const type = raw_market.info.type;
                const base = raw_market.base;
                const quote = raw_market.quote;
                const bid = parseFloat(raw_market.info.bid);
                const ask = parseFloat(raw_market.info.ask);
                const expiration = (raw_market.expiration != null ? raw_market.expiration : null);
                const contract_size = (raw_market.info.contractSize != null ? raw_market.info.contractSize : 1);
                const precision = raw_market.precision;
                const raw = raw_market.info;
                const tvsymbol = 'FTX:' + symbol.replace('-','').replace('/','');
                const market = new this.classes.market(exchange, id, symbol, type, base, quote, bid, ask, expiration, contract_size, precision, tvsymbol, raw)
                results.push(market);
            });
        return results;
    }


    // Get open orders

    async open_orders(params) {
        var [symbol, since, limit] = this.mod.utils.extract_props(params, ['symbol', 'since', 'limit']);
        let raworders1 = await this.execute('fetch_open_orders',[symbol, since, limit, {method: 'privateGetOrders'}]);
        let raworders2 = await this.execute('fetch_open_orders',[symbol, since, limit, {method: 'privateGetConditionalOrders'}]);
        var raworders = this.merge_orders(raworders1, raworders2);
        return this.parse_orders(raworders);
    }

    // Get all order history

    async all_orders(params) {
        var [symbol, since, limit] = this.mod.utils.extract_props(params, ['symbol', 'since', 'limit']);
        let raworders1 = await this.execute('fetch_orders',[symbol, since, limit, {method: 'privateGetOrdersHistory'}]);
        let raworders2 = await this.execute('fetch_orders',[symbol, since, limit, {method: 'privateGetConditionalOrdersHistory'}]);
        var raworders = this.merge_orders(raworders1, raworders2);
        return this.parse_orders(raworders);
    }

    // Cancel orders

    async cancel(params) {
        var [symbol, id] = this.mod.utils.extract_props(params, ['symbol', 'id']);
        var orders = await this.open_orders({symbol: symbol});
        if (id.toLowerCase() == 'all') {
            let result = await this.ccxtobj.privateDeleteOrders({market: symbol});
            if (String(result.success) == "true") {
                orders.forEach((order, idx) => {
                    order.status = 'cancelled';
                    orders[idx] = order;
                })   
            } 
        } else {
            orders = orders.filter(order => ['all',order.id].includes(id));
            await orders.forEach(async (order) => {
                var id = order.id;
                if (['market','limit'].includes(order.type)) {
                    await this.ccxtobj.privateDeleteOrdersOrderId({'order_id': id});
                } else {
                    await this.ccxtobj.privateDeleteConditionalOrdersOrderId({'order_id': id});
                }
            });
            orders.forEach((order, idx) => {
                order.status = 'cancelled';
                orders[idx] = order;
            })    
        }
        return orders;
    }


    // Parse CCXT order format into Frostybot order format

    parse_order(order) {
        if (order instanceof this.classes.order) {
            return order;
        }
        const symbol = order.symbol;
        const id = order.id;
        const timestamp = order.timestamp;
        const direction = order.side;
        const trigger = (order.info.trailValue != undefined ? order.info.trailValue : (order.info.triggerPrice != undefined ? order.info.triggerPrice : null));
        //const market_price = (direction == 'buy' ? market.ask : market.bid);
        const price = (order.info.orderPrice != null ? order.info.orderPrice : (order.price != null ? order.price : (trigger != null ? trigger : null)));
        const size = order.amount;
        const filled = order.filled;
        var type = order.type.toLowerCase();
        switch (type) {
            case 'stop'          :  type = (price != trigger ? 'stop_limit' : 'stop_market');
                                    break;
            case 'take_profit'   :  type = (price != trigger ? 'takeprofit_limit' : 'takeprofit_market');
                                    break;
        }
        const status = order.status.replace('canceled', 'cancelled');   // Fix spelling error
        const raw = order.info;
        var uuid = this.stub.uuid == undefined ? context.get('uuid') : null
        return new this.classes.order(uuid, this.stub.stub, 'ftx', symbol, id, timestamp, type, direction, price, trigger, size, filled, status, raw);
    }


}
