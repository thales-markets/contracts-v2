const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');
const fs = require('fs');
const { getMerkleTree } = require('../../../test/utils/merkleTree/merkleTree');
const markets = require(`./markets.json`);

async function updateMerkleTree() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const { root, treeMarketsAndHashes } = await getMerkleTree(markets);

	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	console.log('Found SportsAMMV2 at:', sportsAMMV2Address);

	const sportsAMMV2Contract = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = sportsAMMV2Contract.attach(sportsAMMV2Address);

	// set new root on contract
	const tx = await sportsAMMV2.setRootPerGame(
		'0x6133363966623838376361663439316230376232393236376635613638366138',
		root
	);
	await tx.wait().then(() => {
		console.log(
			'New root set for game 0x6133363966623838376361663439316230376232393236376635613638366138'
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
