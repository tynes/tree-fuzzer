const rules = require('hsd/lib/covenants/rules');
const {Network} = require('hsd');
const NodeFactory = require('./nodefactory');
const random = require('bcrypto/lib/random');
const AuctionRunner = require('./auctionrunner');
const consensus = require('hsd/lib/protocol/consensus');
const Logger = require('blgr');

// confirm that peers are receiving blocks in different orders
// make fork point interval more random
// eventually be able to keep around old chains - rpc reconsiderblock
// make sure we are reorging past certain auction states
// make sure wallet is able to handle those reorgs
// log when reorg between tree intervals
// log disconnected auction txs
// refactor connect statements to be logged inside
// of the node, not inside of the auctionrunner

module.exports = async (options) => {
  const factory = new NodeFactory();
  const miner = await factory.createHSD();

  const logger = options.obj('logger') || new Logger();

  // when the setTimeout is too small, it breaks things
  miner.node.pool.announceBlock = function announceBlock(msg) {
    const pool = miner.node.pool;
    for (let peer = pool.peers.head(); peer; peer = peer.next) {
      setTimeout(() => {
        peer.announceBlock(msg);
      }, random.randomRange(1e3, 6e4));
    }
  }

  miner.node.chain.on('connect', (entry) => {
    logger.info('connect - height: %i', entry.height);
    logger.info('root - %x', entry.treeRoot);
  });

  miner.node.chain.on('disconnect', (entry) => {
    logger.info('disconnect - height: %i', entry.height);
  });

  miner.node.mempool.on('tx', (tx) => {
    logger.info(`mempool tx: %s`, tx.txid().toString('hex'));
    // TODO: log the name
  });

  const ncount = options.uint('ncount', 1);
  const network = options.str('network', 'regtest');
  const nodes = []; // keep track of the nodes

  for (let i = 0; i < ncount; i++) {
    // TODO: allow different processes
    const node = await factory.createHSD();
    await node.rpc('addnode', [miner.addr, 'add'])
    nodes.push(node);
  }

  // create the auction runners
  const nrunner = options.uint('nrunner', 1);
  const runners = [];

  for (let i = 0; i < nrunner; i++) {
    // grab a random node from nodes array
    // connect using its node client and wallet client
    const index = random.randomRange(0, nodes.length - 1);
    const node = nodes[index];

    const runner = new AuctionRunner({
      node: node.nclient,
      wclient: node.wclient,
      network: network,
      logger: logger.context(`runner-${i}`)
    });

    // preload the runner's wallet
    if (options.bool('preload', true)) {
      const receive = await runner.createAddress();
      await miner.nclient.execute('generatetoaddress', [5, receive]);
    }

    // have the miner send funds to the runner
    // when the runner needs funds
    runner.on('need funds', async (address) => {
      try {
        const tx = await miner.wclient.send('primary', {
          outputs: [{ value: 2 * consensus.COIN, address: address }]
        });

        logger.info('tx send: %s', tx.hash);
      } catch (e) {
        logger.error(e.message);
      }
    });

    await runner.ensure();
    await runner.open();

    runners.push(runner);
  }

  // start mining
  setInterval(async () => {
    const {wdb} = miner.node.require('walletdb');
    const address = await wdb.primary.receiveAddress();
    const addr = address.toString(network);

    try {
      // this causes an exception if it mines an orphan block
      await miner.nclient.execute('generatetoaddress', [5, addr]);
    } catch (e) {
      ;
    }

    // TODO: more random fork point
    const forkPoint = miner.node.chain.height - 3;
    const entry = await miner.node.chain.getEntryByHeight(forkPoint);
    if (!entry)
      return;

    const hash = entry.hash.toString('hex');
    await miner.rpc('invalidateblock', [hash]);
  }, 2e3);

  // wait for the height to be at least 5
  // before proceeding
  let handle;
  await new Promise((resolve) => {
    handle = setInterval(async () => {
      const info = await miner.nclient.getInfo();
      if (info.chain.height > 5) {
        clearInterval(handle)
        resolve();
      }
    }, 1e2);
  });

  // start the auction process
  for (const runner of runners) {
    // start new auctions
    setInterval(async () => {
      const size = random.randomRange(1, 10);
      let name;

      try {
        const height = Math.max(0, miner.node.chain.height - 10);
        name = rules.grindName(size, height, Network.get(network));
      } catch (e) {
        name = await miner.nclient.execute('grindname', [size]);
      }

      runner.run(name);
    }, random.randomRange(3e3, 20e3));
  }
}

