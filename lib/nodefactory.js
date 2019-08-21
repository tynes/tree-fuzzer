'use strict';

const hsd = require('hsd');
const {NodeClient, WalletClient} = require('hs-client');
const format = require('blgr/lib/format');

const path = require('path');
const bcurl = require('bcurl');
const cp = require('child_process');

class NodeFactory {
  constructor() {
    this.count = 0;
  }

  createDir(index) {
    const dataDir = path.join(__dirname, `data/datadir_${index}`);

    cp.spawnSync('rm', ['-rf', dataDir]);
    cp.spawnSync('mkdir', [dataDir]);

    return dataDir;
  }

  getPorts(index) {
    return {
      port: 10000 + index,
      rpcport: 15000 + index,
      nsport: 20000 + index,
      rsport: 25000 + index,
      walletport: 30000 + index
    };
  }

  initNode() {
    this.count += 1;
    const index = this.count;
    const dataDir = this.createDir(index);
    const ports = this.getPorts(index);

    const client = bcurl.client({
      password: 'x',
      port: ports.rpcport
    });

    // do I need rpc and client?
    const rpc = function (cmd, args) {
      return client.execute('', cmd, args);
    };

    // trying to conenct to wrong port!
    const nclient = new NodeClient({
      port: ports.rpcport
    });

    const wclient = new WalletClient({
      port: ports.walletport
    });

    return {
      index,
      dataDir,
      ports,
      rpc,
      client,
      nclient,
      wclient
    };
  }

  async createHSD() {
    const {index, dataDir, ports, rpc, nclient, wclient} = this.initNode();

    const node = new hsd.FullNode({
      network: 'regtest',
      workers: true,
      logLevel: 'none', // TODO: make configurable
      listen: true,
      prefix: `${dataDir}`,
      memory: false,
      port: ports.port,
      httpPort: ports.rpcport,
      nsPort: ports.nsport,
      rsPort: ports.rsport,
      maxOutbound: 1,
      prune: false,
      bip37: true,
      plugins: [require('hsd/lib/wallet/plugin')],
      env: {
        HSD_WALLET_HTTP_PORT: ports.walletport.toString()
      }
    });

    const printStdout = this.printStdout;
    node.logger.logger.writeConsole = function(level, module, args) {
      printStdout(index, '[' + module + '] ' + format(args, false));
    };

    await node.ensure();
    await node.open();
    await node.connect();
    node.startSync();

    const addr = node.pool.hosts.address.fullname();

    return {index, dataDir, ports, rpc, node, addr, nclient, wclient};
  }

  spawnSyncPrint(id, cmd, arg, opt) {
    const proc = cp.spawn(cmd, arg, opt);

    proc.stdout.on('data', (data) => {
      this.printStdout(id, data);
    });

    proc.stderr.on('data', (data) => {
      this.printStdout(id, data);
    });

    proc.on('close', (code) => {
      return(code);
    });

    proc.on('error', (data) => {
      this.printStdout(id, data);
    });
  }

  printStdout(index, data) {
    const header = `${index}:  `;
    let str = data.toString();
    str = str.replace(/\n/g, `\n${header}`);
    str = header + str;
    console.log(`\x1b[${31 + index}m%s\x1b[0m`, str);
  }
}

module.exports = NodeFactory;
