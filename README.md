# tree fuzzer

Create reorgs and run auctions using `hsd`.
A miner is created that sends blocks out in random orders to its peers.
A number of full nodes are created and peer with the miner.
The `AuctionRunner` class creates listeners and automates the
auction process. The miner will create reorgs by invalidating
blocks and then continuing to mine.

## Usage

Clone from Github and then install dependencies using `npm`.

The `ncount` argument determines the number of full nodes to start.
The `nrunner` argument determines the number of `AuctionRunner`s to start.

```bash
$ ./bin/cli --ncount 2 --nrunner 3
```
