const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { web3 } = require('hardhat');
const fs = require('fs');
const { ethers } = require('hardhat');
const markets = require(`./markets.json`);
const { getTargetAddress } = require('../../helpers');

async function updateMerkleTree() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	// if (networkObj.chainId == 420) {
	// 	networkObj.name = 'optimisticGoerli';
	// 	network = 'optimisticGoerli';
	// }

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

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
		console.log('Market:', market);

		let marketLeaf = getLeaf(market, true);
		treeMarketsHashes.push(marketLeaf.hash);
		market.childMarkets.forEach((childMarket) => {
			console.log('Child market:', childMarket);

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

	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	console.log('Found SportsAMMV2 at:', sportsAMMV2Address);

	const sportsAMMV2Contract = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = sportsAMMV2Contract.attach(sportsAMMV2Address);

	// set new root on contract
	const tx = await sportsAMMV2.setRootPerGame(
		'0x3063613139613935343563616437636230393634613865623435363366336666',
		root
	);
	await tx.wait().then(() => {
		console.log(
			'New root set for game 0x3063613139613935343563616437636230393634613865623435363366336666'
		);
	});

	fs.writeFileSync(
		`scripts/deployOvertime/updateMerkleTree/treeMarketsAndHashes.json`,
		JSON.stringify(treeMarketsAndHashes),
		function (err) {
			if (err) return console.log(err);
		}
	);
}

updateMerkleTree()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
