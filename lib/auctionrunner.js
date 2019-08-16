/*
 * Auction Runner
 */

'use strict';

const assert = require('bsert');
const AsyncEmitter = require('bevent');
const rules = require('hsd/lib/covenants/rules');
const {Network} = require('hsd');
const {NodeClient, WalletClient} = require('hs-client');
const NameState = require('hsd/lib/covenants/namestate');
const random = require('bcrypto/lib/random');
const {types} = rules;
const {states} = NameState;

class AuctionRunner extends AsyncEmitter {
  constructor(options) {
    super();
    this.node = new NodeClient(options);
    this.wclient = new WalletClient(options);
    this.network = Network.get('main');

    // wallet id and wallet account
    this.id = 'primary';
    this.account = 'default';

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

    return this;
  }

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

      const txn = await this.sendBid(name, {
        bid: bid,
        lockup: lockup
      });
    });

    this.on('reveal', async (name) => {
      await this.ensureFunds();
      await this.sendReveal(name);
    });

    this.on('need funds', async () => {
      await new Promise(resolve => {
        this.wclient.once('confirmed', () => {
          resolve();
        });
      });
    });

    this.wclient.on('connect', async () => {
      await this.wclient.call('join', this.id);
    });

    this.wclient.bind('alert', (wallet, ns) => {
      console.log(`ALERT: ${wallet} - ${ns.name} - ${ns.state}`);

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
          console.log(`TODO: implement ${state}`);
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

  async ensureFunds() {
    let info = await this.wallet.getAccount(this.account);
    const balance = info.balance.confirmed;

    if (balance < 1000) {
      await this.emitAsync('need funds', info.receiveAddress);
      info = await this.wallet.getAccount(this.account);
    }

    return info;
  }

  async run(name) {
    name = await this.ensureName(name);
    console.log(`running: ${name}`);
    this.emit('open', name);
  }

  async ensureName(name) {
    if (name)
      return name;

    const len = random.randomRange(1, 63);
    name = await this.node.execute('grindname', [len]);
    return name;
  }

  async sendOpen(name) {
    assert(typeof name === 'string', 'Must pass name.');

    const {wallet} = this;

    const open = await wallet.client.post(`/wallet/${this.id}/open`, {
      name: name,
      account: this.account
    });

    return open;
  }

  async sendBid(name, options) {
    const {bid, lockup} = options;
    assert(typeof name === 'string', 'Must pass name.');
    assert(bid, 'Must pass bid.');
    assert(lockup, 'Must pass lockup.');

    const {wallet} = this;

    const tx = await wallet.client.post(`/wallet/${this.id}/bid`, {
      name: name,
      bid: bid,
      lockup: lockup,
      account: this.account
    });

    return tx;
  }

  async sendReveal(name) {
    assert(name, 'Must pass name.');
    const {wallet} = this;

    const tx = await wallet.client.post(`/wallet/${this.id}/reveal`, {
      name: name,
      account: this.account
    });

    return tx;
  }

  async sendUpdate(name, data) {
    assert(name, 'Must pass name.');
    assert(data, 'Must pass data.');
    const {wallet} = this;

    const tx = await wallet.client.post(`/wallet/${this.id}/update`, {
      name: name,
      data: data,
      account: this.account
    });

    return tx;
  }

  async sendRenew(name) {
    assert(name, 'Must pass name.');
    const {wallet} = this;

    const tx = await wallet.client.post(`/wallet/${this.id}/renew`, {
      name: name,
      account: this.account
    });

    return tx;
  }

  async sendRedeem(name) {
    const {wallet} = this;

    const tx = await wallet.client.post(`/wallet/${this.id}/redeem`, {
      name: name,
      account: this.account
    });

    return tx;
  }
}

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

module.exports = AuctionRunner;

