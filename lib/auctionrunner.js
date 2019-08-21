/*
 * Auction Runner
 */

'use strict';

const assert = require('bsert');
const AsyncEmitter = require('bevent');
const rules = require('hsd/lib/covenants/rules');
const {Network, ChainEntry} = require('hsd');
const {NodeClient, WalletClient} = require('hs-client');
const util = require('hsd/lib/utils/util');
const NameState = require('hsd/lib/covenants/namestate');
const consensus = require('hsd/lib/protocol/consensus');
const random = require('bcrypto/lib/random');
const Logger = require('blgr');
const {types} = rules;
const {states} = NameState;

/**
 * AuctionRunner
 * Create auctions and automate the
 * bidding process.
 */

class AuctionRunner extends AsyncEmitter {
  constructor(options) {
    super();
    this.node = new NodeClient(options);
    this.wclient = new WalletClient(options);
    this.network = Network.get('main');

    // wallet id and wallet account
    this.id = 'primary';
    this.account = 'default';

    this.logger = new Logger();

    this.wallet = this.wclient.wallet(this.id);

    if (options)
      this.fromOptions(options)
  }

  fromOptions(options) {
    if (options.wclient) {
      this.wclient = options.wclient;
      this.wallet = this.wclient.wallet(this.id);
    }

    if (options.node)
      this.node = options.node;

    if (typeof options.id === 'string') {
      this.id = options.id;
      this.wallet = this.wclient.wallet(this.id);
    }

    if (typeof options.account === 'string')
      this.account = options.account;

    if (typeof options.network === 'string')
      this.network = Network.get(options.network);
    else if (options.network)
      this.network = options.network;

    if (options.logger)
      this.logger = options.logger;

    return this;
  }

  /**
   * Set up event listeners.
   */

  async open() {
    this.on('open', async (name) => {
      const info = await this.ensureFunds();

      await this.sendOpen(name);
    });

    this.on('bid', async (name) => {
      const info = await this.ensureFunds();
      const balance = info.balance.confirmed;

      const bid = Number((balance * 0.1).toFixed(0));
      const lockup = bid * 2;

      await this.sendBid(name, {
        bid: bid,
        lockup: lockup
      });
    });

    this.on('reveal', async (name) => {
      await this.ensureFunds();

      await this.sendReveal(name);
    });

    this.on('need funds', async (address) => {
      this.logger.info('need funds: %s', address);

      await new Promise(resolve => {
        const handler = async (id, json) => {
          const addrs = [];
          for (const output of json.outputs)
            addrs.push(output.address);

          if (addrs.includes(address)) {
            // why is wclient.unbind not defined?
            this.wclient.socket.unbind('confirmed', handler);
            resolve()
          }
        }

        this.wclient.bind('confirmed', handler.bind(this));
      });
    });

    this.wclient.on('connect', async () => {
      await this.wclient.call('join', this.id);
    });

    this.node.on('connect', async () => {
      await this.node.call('watch chain');
    });

    // log the timestamp for certainty around
    // the nodes receiving the blocks in different orders
    this.node.bind('chain connect', (entry) => {
      const chainentry = ChainEntry.fromRaw(entry);
      const hash = chainentry.hash.toString('hex');
      const time = util.now();
      this.logger.info('connect %s (%s)', hash, time);
      this.emit('connect', chainentry);
    });

    this.node.bind('chain disconnect', (entry) => {
      const chainentry = ChainEntry.fromRaw(entry);
      const hash = chainentry.hash.toString('hex');
      const time = util.now();
      this.logger.info('disconnect %s (%s)', hash, time);
      this.emit('disconnect', chainentry);
    });

    this.node.bind('chain reorganize', (competitor) => {
      const chainentry = ChainEntry.fromRaw(competitor);
      const hash = chainentry.hash.toString('hex');
      const time = util.now();
      this.logger.info('Reorganize %s (%s)', hash, time);
      this.emit('reorganize', chainentry);
    });

    this.wclient.bind('alert', (wallet, ns) => {
      this.logger.info('alert: %s - %s', ns.name, ns.state);

      const state = states[ns.state];
      switch (state) {
        case states.OPENING:
          this.emit('open', ns.name);
          break;
        case states.BIDDING:
          this.emit('bid', ns.name);
          break;
        case states.REVEAL:
          this.emit('reveal', ns.name);
          break;
        default:
          this.logger.info('TODO: implement %s', ns.state);
      }
    });

    this.wclient.bind('mempool tx', async () => {
      if (this.mine) {
        const info = await this.wallet.createAddress(this.account);
        const addr = info.address;
        await this.node.execute('generatetoaddress', [1, addr]);
      }
    });

    if (!this.node.opened)
      await this.node.open();
    if (!this.wclient.opened)
      await this.wclient.open();
  }

  /**
   * Create a new receive address.
   */

  async createAddress() {
    const info = await this.wallet.createAddress(this.account);
    return info.address;
  }

  /**
   * Ensure that the correct wallet and
   * account exist.
   */

  async ensure() {
    try {
      await this.wclient.createWallet(this.id);
    } catch (e) {
      ;
    }

    try {
      await this.wallet.createAccount(this.account);
    } catch (e) {
      ;
    }
  }

  /**
   * Ensure that the wallet has enough funds.
   */

  async ensureFunds() {
    let info = await this.wallet.getAccount(this.account);
    const balance = info.balance.confirmed;

    if (balance < 1 * consensus.COIN) {
      await this.emitAsync('need funds', info.receiveAddress);
      info = await this.wallet.getAccount(this.account);
    }

    return info;
  }

  /**
   * Kick off a name auction.
   */

  async run(name) {
    name = await this.ensureName(name);
    this.logger.info('running: %s', name);
    await this.emitAsync('open', name);
  }

  /**
   * Ensure that a name is used.
   * @param {String} name
   * @returns {String}
   */

  async ensureName(name) {
    if (name)
      return name;

    const len = random.randomRange(1, 63);
    name = await this.node.execute('grindname', [len]);
    return name;
  }

  /**
   * Spend a name to open state.
   * @param {String} name
   */

  async sendOpen(name) {
    assert(typeof name === 'string', 'Must pass name.');

    const {wallet} = this;

    let tx;
    try {
      tx = await wallet.client.post(`/wallet/${this.id}/open`, {
        name: name,
        account: this.account
      });
    } catch (e) {
      this.logger.error('Open: %s', e.message);
    }

    return tx;
  }

  /**
   * Spend a name to a bid state.
   * @param {String} name
   * @param {Object} options
   *
   * Consider moving bid/lockup calculation
   * into this function if values are not passed.
   */

  async sendBid(name, options) {
    const {bid, lockup} = options;
    assert(typeof name === 'string', 'Must pass name.');
    assert(bid, 'Must pass bid.');
    assert(lockup, 'Must pass lockup.');

    const {wallet} = this;

    let tx;
    try {
      tx = await wallet.client.post(`/wallet/${this.id}/bid`, {
        name: name,
        bid: bid,
        lockup: lockup,
        account: this.account
      });
    } catch (e) {
      this.logger.error('Bid: %s', e.message);
    }

    return tx;
  }

  /**
   * Spend a name to a reveal state.
   * @param {String} name
   */

  async sendReveal(name) {
    assert(name, 'Must pass name.');
    const {wallet} = this;

    let tx;
    try {
      tx = await wallet.client.post(`/wallet/${this.id}/reveal`, {
        name: name,
        account: this.account
      });
    } catch (e) {
      this.logger.error('Reveal: %s', e.message);
    }

    return tx;
  }

  /**
   * Spend a name to an update state.
   * @param {String} name
   */

  async sendUpdate(name, data) {
    assert(name, 'Must pass name.');
    assert(data, 'Must pass data.');
    const {wallet} = this;

    let tx;
    try {
      tx = await wallet.client.post(`/wallet/${this.id}/update`, {
        name: name,
        data: data,
        account: this.account
      });
    } catch (e) {
      this.logger.error('Update: %s', e.message);
    }

    return tx;
  }

  /**
   * Spend a name to a renew state.
   * @param {String} name
   */

  async sendRenew(name) {
    assert(name, 'Must pass name.');
    const {wallet} = this;

    let tx;
    try {
      tx = await wallet.client.post(`/wallet/${this.id}/renew`, {
        name: name,
        account: this.account
      });
    } catch (e) {
      this.logger.error('Renew: %s', e.message);
    }

    return tx;
  }

  /**
   * Spend a name to a redeem state.
   * @param {String} name
   */

  async sendRedeem(name) {
    const {wallet} = this;

    let tx;
    try {
      tx = await wallet.client.post(`/wallet/${this.id}/redeem`, {
        name: name,
        account: this.account
      });
    } catch (e) {
      this.logger.error('Redeem: %s', e.message);
    }

    return tx;
  }
}

module.exports = AuctionRunner;

