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

	markets.forEach((market, index) => {
		console.log('Market:', market);

		let hash = keccak256(
			market.odds.length > 2
				? web3.utils.encodePacked(
						market.marketAddress,
						market.sportId,
						ethers.parseEther(market.odds[0].toString()).toString(),
						ethers.parseEther(market.odds[1].toString()).toString(),
						ethers.parseEther(market.odds[2].toString()).toString()
				  )
				: web3.utils.encodePacked(
						market.marketAddress,
						market.sportId,
						ethers.parseEther(market.odds[0].toString()).toString(),
						ethers.parseEther(market.odds[1].toString()).toString()
				  )
		);
		let marketLeaf = {
			marketAddress: market.marketAddress,
			market: market.sportId,
			odds: market.odds.map((o) => ethers.parseEther(o.toString()).toString()),
			hash,
			proof: '',
			index: index,
		};
		treeMarketsHashes.push(hash);
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

	for (let toh in treeMarketsAndHashes) {
		treeMarketsAndHashes[toh].proof = merkleTree.getHexProof(treeMarketsAndHashes[toh].hash);
		delete treeMarketsAndHashes[toh].hash;
	}

	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	console.log('Found SportsAMMV2 at:', sportsAMMV2Address);

	const sportsAMMV2Contract = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = sportsAMMV2Contract.attach(sportsAMMV2Address);

	// set new root on contract
	const tx = await sportsAMMV2.setRoot(root);
	await tx.wait().then(() => {
		console.log('New root set');
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
