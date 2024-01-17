const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { web3 } = require('hardhat');
const { ethers } = require('hardhat');

async function getMerkleTree(markets) {
	let treeMarketsHashes = [];
	let treeMarketsAndHashes = [];

	const getLeaf = (market, isParent) => {
		let encodePackedOutput = web3.utils.encodePacked(
			market.gameId,
			market.sportId,
			market.childId,
			market.playerPropsId,
			market.maturity,
			market.status,
			market.childId === 10001
				? market.spread
				: market.childId === 10002
				  ? market.total
				  : market.childId === 10010
				    ? market.playerProps.line
				    : 0,
			market.playerProps.playerId
		);

		for (i = 0; i < market.odds.length; i++) {
			encodePackedOutput = web3.utils.encodePacked(
				encodePackedOutput,
				ethers.parseEther(market.odds[i].toString()).toString()
			);
		}

		let hash = keccak256(encodePackedOutput);

		let marketLeaf = {
			...market,
			odds: market.odds.map((o) => ethers.parseEther(o.toString()).toString()),
			hash,
			proof: '',
		};
		if (isParent) {
			marketLeaf.childMarkets = [];
		}

		return marketLeaf;
	};

	markets.forEach((market) => {
		let marketLeaf = getLeaf(market, true);
		treeMarketsHashes.push(marketLeaf.hash);
		market.childMarkets.forEach((childMarket) => {
			let childMarketLeaf = getLeaf(childMarket);
			marketLeaf.childMarkets.push(childMarketLeaf);
			treeMarketsHashes.push(childMarketLeaf.hash);
		});

		treeMarketsAndHashes.push(marketLeaf);
	});

	// create merkle tree
	const merkleTree = new MerkleTree(treeMarketsHashes, keccak256, {
		sortLeaves: true,
		sortPairs: true,
	});

	// set tree root
	const root = merkleTree.getHexRoot();
	console.log('Merkle Tree root:', root);

	treeMarketsAndHashes.forEach((tmh) => {
		tmh.proof = merkleTree.getHexProof(tmh.hash);
		delete tmh.hash;
		tmh.childMarkets.forEach((tmhcm) => {
			tmhcm.proof = merkleTree.getHexProof(tmhcm.hash);
			delete tmhcm.hash;
		});
	});

	return { root, treeMarketsAndHashes };
}

module.exports = {
	getMerkleTree,
};
