const NodeFactory = require('./nodefactory');
const random = require('bcrypto/lib/random');
const AuctionRunner = require('./auctionrunner');
const consensus = require('hsd/lib/protocol/consensus');

module.exports = async (options) => {
  const factory = new NodeFactory();
  const miner = await factory.createHSD();

  const rng = options.func('rng') || random;

  miner.node.pool.announceBlock = function announceBlock(msg) {
    const pool = miner.node.pool;
    for (let peer = pool.peers.head(); peer; peer = peer.next) {
      setTimeout(() => {
        peer.announceBlock(msg);
      }, random.randomRange(0, 6e4));
    }
  }

  miner.node.chain.on('connect', (entry) => {
    console.log(`height: ${entry.height}`);
    console.log(`root: ${entry.treeRoot.toString('hex')}`);
  });

  const ncount = options.uint('ncount', 1);
  const network = options.str('network', 'regtest');

  for (let i = 0; i < ncount; i++) {
    // make them different processes?
    const node = await factory.createHSD();
    await node.rpc('addnode', [miner.addr, 'add'])
  }

  // start mining
  setInterval(async () => {
    const {wdb} = miner.node.require('walletdb');
    const address = await wdb.primary.receiveAddress();
    // TODO: configurable network
    const addr = address.toString(network);
    // this causes an exception if it mines an orphan block
    try {
      await miner.nclient.execute('generatetoaddress', [5, addr]);
    } catch (e) {
      ;
    }

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
        resolve();
        clearInterval(handle)
      }
    }, 1e3);
  });

  // create the auction runners
  const nrunner = options.uint('nrunner', 1);

  for (let i = 0; i < nrunner; i++) {
    // TEMP: using miner clients and nrunner of 1
    // for simplicity. migrate to creating a
    // pair of clients for each runner.
    const runner = new AuctionRunner({
      node: miner.nclient,
      wclient: miner.wclient,
      network: network
    });

    // have the miner send funds to the runner
    // when the runner needs funds
    runner.on('need funds', async (address) => {
      try {
        const tx = await miner.wclient.send('primary', {
          outputs: [{ value: 1*consensus.COIN, address: address }]
        });
      } catch (e) {
        console.log(e)
      }
    });

    await runner.ensure();
    await runner.open();

    // start new auctions
    setInterval(async () => {
      const size = rng.randomRange(1, 10);
      //const name = await miner.rpc('grindname', [size]);
      const name = await miner.nclient.execute('grindname', [size]);

      runner.run(name);
    }, 5e3);
  }
}

