const { CHILD_ID_SPREAD, CHILD_ID_TOTAL, CHILD_ID_PLAYER_PROPS } = require('../constants/overtime');
const markets = require(`../../scripts/deployOvertime/updateMerkleTree/markets.json`);
const { ONE_DAY_IN_SECS, ONE_WEEK_IN_SECS } = require('../constants/general');
const { getMerkleTree } = require('./merkleTree/merkleTree');
const fs = require('fs');

const getGameLine = (game) =>
	game.childId === CHILD_ID_SPREAD
		? game.spread
		: game.childId === CHILD_ID_TOTAL
		  ? game.total
		  : game.childId === CHILD_ID_PLAYER_PROPS
		    ? game.playerProps.line
		    : 0;

const getTradeDataItem = (game, position) => {
	return {
		gameId: game.gameId,
		sportId: game.sportId,
		childId: game.childId,
		playerPropsId: game.playerPropsId,
		maturity: game.maturity,
		status: game.status,
		line: getGameLine(game),
		playerId: game.playerProps.playerId,
		odds: game.odds,
		merkleProof: game.proof,
		position: position,
	};
};

const getTicketTradeData = () => {
	const marketsTree = require(`./merkleTree/treeMarketsAndHashes.json`);
	const nbaMoneylineCurrentRound = marketsTree[0];
	const nbaMoneylineNextRound = marketsTree[1];
	const nbaSpreadNextRound = marketsTree[1].childMarkets[0];

	const tradeDataCurrentRound = [];
	tradeDataCurrentRound.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));

	const tradeDataNextRound = [];
	tradeDataNextRound.push(getTradeDataItem(nbaMoneylineNextRound, 0));

	const tradeDataCrossRounds = [];
	tradeDataCrossRounds.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));
	tradeDataCrossRounds.push(getTradeDataItem(nbaSpreadNextRound, 1));

	return { tradeDataCurrentRound, tradeDataNextRound, tradeDataCrossRounds };
};

const createMerkleTree = async () => {
	const marketInCurrentRound = markets[0];
	const marketInCrossRounds = markets[1];

	const today = Math.round(new Date().getTime() / 1000);
	const tomorrow = today + ONE_DAY_IN_SECS;
	const nextWeek = tomorrow + ONE_WEEK_IN_SECS;

	marketInCurrentRound.maturity = tomorrow;
	marketInCurrentRound.childMarkets.forEach((childMarket) => {
		childMarket.maturity = tomorrow;
	});

	marketInCrossRounds.maturity = nextWeek;
	marketInCrossRounds.childMarkets.forEach((childMarket) => {
		childMarket.maturity = nextWeek;
	});

	const newMarkets = [marketInCurrentRound, marketInCrossRounds];

	const { root, treeMarketsAndHashes } = await getMerkleTree(newMarkets);

	fs.writeFileSync(
		`test/utils/merkleTree/treeMarketsAndHashes.json`,
		JSON.stringify(treeMarketsAndHashes),
		function (err) {
			if (err) return console.log(err);
		}
	);

	return root;
};

module.exports = {
	getTicketTradeData,
	createMerkleTree,
};
