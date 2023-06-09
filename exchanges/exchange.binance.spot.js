frostybot_exchange_binance_base = require('./exchange.binance.base');

module.exports = class frostybot_exchange_binance_spot extends frostybot_exchange_binance_base {

    // Class constructor

    constructor(stub = undefined) {
        super(stub);
        this.type = 'spot'                           // Exchange subtype
        this.shortname = 'binance_spot'              // Abbreviated name for this exchange
        this.description = 'Binance Spot'            // Full name for this exchange
        this.has_subaccounts = false                 // Subaccounts supported?
        this.has_testnet = true                      // Test supported?
        this.stablecoins = ['USDT','BUSD'];          // Stablecoins supported on this exchange
        this.order_sizing = 'base';                  // Exchange requires base size for orders
        this.collateral_assets = ['USDT','BUSD'];    // Assets that are used for collateral
        this.exchange_symbol = 'symbol';             // Does CCXT use the ID or the Symbol field?
        this.balances_market_map = '{currency}/{stablecoin}'  // Which market to use to convert non-USD balances to USD
        this.orders_symbol_required = true;          // This exchange requires a symbol when fetching orders
        this.param_map = {                           // Order parameter mappings
            limit              : 'LIMIT',
            market             : 'MARKET',
            stoploss_limit     : 'STOP_LOSS_LIMIT',
            stoploss_market    : 'STOP_LOSS_LIMIT',
            takeprofit_limit   : 'TAKE_PROFIT_LIMIT', 
            takeprofit_market  : 'TAKE_PROFIT',
            take_profit_limit  : 'TAKE_PROFIT_LIMIT', 
            take_profit_market : 'TAKE_PROFIT_MARKET',
            trailing_stop      : null, 
            post               : null,                // TODO
            reduce             : 'reduceOnly',
            ioc                : null,                // TODO
            tag                : null,                // TODO
            trigger            : 'stopPrice',
        };
        this.map_mod()
    }

    // Get CCXT Parameters

    ccxtparams() {
        var params = {
            options: {
                defaultType : 'spot',
            }
        }

        if (this.stub != undefined) {
            var stub = this.stub;
            params['apiKey'] = stub.parameters.apikey;
            params['secret'] = stub.parameters.secret;
            if (String(stub.parameters.testnet) == 'true') {
                const ccxtlib = require ('ccxt');                
                const testclass = ccxtlib['binance'];
                var testobj = new testclass ();
                var urls = testobj.urls != undefined ? testobj.urls : {};
                params['urls'] = urls;
                if (urls.hasOwnProperty('test')) params.urls.api = urls.test;
            }
        }
        return ['binance', params];

    }    


    // Custom params

    async custom_params(params) {
        var [type, order_params, custom_params] = params
        return order_params;
    }    

    
    // Get available equity in USD for placing an order on a specific symbol using size as a factor of equity (size=1x)

    async available_equity_usd(symbol) {
        return await this.total_balance_usd();
    }

    // Get list of current positions

    async positions() { 
        // Emulate spot "positions" against USD for non-stablecoin balances
        var markets = await this.markets();
        var positions = []; 
        var balances = await this.balances();
        balances.forEach(async (balance) => {
            markets.forEach(async (market) => {
                if ((market.base == balance.currency) && (market.quote == 'USDT')) {
                    const direction = 'long';
                    const base_size = balance.base.total;
                    const position = new this.classes.position_spot(this.stub.uuid, this.stub.stub, 'binance_spot', market.symbol, direction, base_size, null);
                    await position.update();
                    positions.push(position)
                }
            })
        });
        /*this.stablecoins.concat('BTC').forEach(async (stablecoin) => {
            balances.forEach(async (balance) => {
                if (!this.stablecoins.includes(balance.currency)) {
                    const symbol = balance.currency + '/' + stablecoin;
                    const market = await this.get_market_by_symbol(symbol);
                    if (market != null) {
                        const direction = 'long';
                        const base_size = balance.base.total;
                        const position = new this.classes.position_spot(market, direction, base_size);
                        positions.push(position)
                    }
                }
            });
        });
        */
        this.positions = positions;
        return this.positions;
    }

    // Get list of markets from exchange

    async markets() {
        var tickers = await this.fetch_tickers();
        var raw_markets = await this.execute('fetch_markets')
        var exchange = (this.shortname != undefined ? this.shortname : (this.constructor.name).split('_').slice(2).join('_'));
        var results = [];
        raw_markets
            .filter(raw_market => raw_market.active == true)
            .forEach(raw_market => {
                const id = raw_market.id;
                const symbol = raw_market.symbol;
                const tvsymbol = 'BINANCE:' + raw_market.symbol.replace('-','').replace('/','');
                const type = 'spot';
                const base = raw_market.base;
                const quote = raw_market.quote;
                var ticker = tickers.hasOwnProperty(id) ? tickers[id] : null;
                const bid = ticker != null ? ticker.bid : null;
                const ask = ticker != null ? ticker.ask : null;
                const expiration = (raw_market.expiration != null ? raw_market.expiration : null);
                const contract_size = (raw_market.info.contractSize != null ? raw_market.info.contractSize : 1);
                //const precision = raw_market.precision;
                const price_filter  = this.mod.utils.filter_objects(raw_market.info.filters, {filterType: 'PRICE_FILTER'} );
                const amount_filter = this.mod.utils.filter_objects(raw_market.info.filters, {filterType: 'LOT_SIZE'} );
                const precision = {
                    price: (price_filter[0].tickSize * 1),
                    amount: (amount_filter[0].stepSize * 1)
                }
                const raw = raw_market.info;
                const market = new this.classes.market(exchange, id, symbol, type, base, quote, bid, ask, expiration, contract_size, precision, tvsymbol, raw)
                results.push(market);
            });
        return results;
    }


    // Fetch tickers

    async fetch_tickers() {
        var results = {};
        var tickersRaw = await this.execute('v3_get_ticker_bookticker')
        for (var i = 0; i < tickersRaw.length; i++) {
            var tickerRaw = tickersRaw[i];
            var symbol = tickerRaw.symbol;
            results[symbol] = {
                bid: this.mod.utils.is_numeric(tickerRaw.bidPrice) ? tickerRaw.bidPrice * 1 : null,
                ask: this.mod.utils.is_numeric(tickerRaw.askPrice) ? tickerRaw.askPrice * 1 : null,
            }
        }
        return results;
    }

    
    // Get open orders

    async open_orders(params) {
        var [symbol, since, limit] = this.mod.utils.extract_props(params, ['symbol', 'since', 'limit']);
        var market = this.find_market(symbol);
        let raworders = await this.ccxtobj.fetch_open_orders(market[this.exchange_symbol], since, limit);
        return this.parse_orders(raworders);
    }

    // Get all order history

    async all_orders(params) {
        var [symbol, since, limit] = this.mod.utils.extract_props(params, ['symbol', 'since', 'limit']);
        var market = this.find_market(symbol);
        let raworders = await this.ccxtobj.fetch_orders(market[this.exchange_symbol], since, limit);
        return this.parse_orders(raworders);
    }

    // Cancel orders

    async cancel(params) {
        var [symbol, id] = this.mod.utils.extract_props(params, ['symbol', 'id']);
        var market = this.find_market(symbol);
        var symbol = market[this.exchange_symbol];
        var orders = await this.open_orders({symbol: symbol});
        console.log('ID: ' + id)
        if ((id.toLowerCase() == 'all') && (orders.length > 0)) {
            let cancel = await this.ccxtobj.cancel_all_orders(symbol);
            orders.forEach((order, idx) => {
                order.status = 'cancelled';
                orders[idx] = order;
            })   
        } else {
            if (id != 'all') {
                orders = orders.filter(order => ['all',order.id].includes(id));
                await orders.forEach(async (order) => {
                    var id = order.id;
                    let orders = await this.ccxtobj.cancel_order({market: symbol, id: id});
                });
                orders.forEach((order, idx) => {
                    order.status = 'cancelled';
                    orders[idx] = order;
                })    
            }
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
        const status = order.status.replace('CANCELED', 'cancelled');   // Fix spelling error
        const raw = order.info;
        var uuid = this.stub.uuid == undefined ? context.get('uuid') : null
        return new this.classes.order(uuid, this.stub.stub, 'binance_spot', symbol, id, timestamp, type, direction, price, trigger, size, filled, status, raw);
    }


}
