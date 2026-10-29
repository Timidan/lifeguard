// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

// Kill test for Lifeguard: can any action the agent is allowed to request lower an Aave V3 health factor?
// Fork: Base Sepolia, Aave V3 market from bgd-labs aave-address-book (AaveV3BaseSepolia.sol).

interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 rateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
    function repayWithATokens(address asset, uint256 amount, uint256 rateMode) external returns (uint256);
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256 availableBorrowsBase, uint256, uint256, uint256 healthFactor);
    function getConfiguration(address asset) external view returns (uint256);
}

interface IOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
}

contract HfClaim is Test {
    IPool constant POOL = IPool(0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27);
    IOracle constant ORACLE = IOracle(0x943b0dE18d4abf4eF02A85912F8fc07684C141dF);
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    address user = address(0xBEEF);
    uint256 ltUsdc; // USDC liquidation threshold, 1e18 scale

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_SEPOLIA_RPC", string("https://sepolia.base.org")));
        ltUsdc = ((POOL.getConfiguration(USDC) >> 16) & 0xFFFF) * 1e14;

        vm.deal(user, 10 ether);
        deal(USDC, user, 2_000e6);
        vm.startPrank(user);
        IWETH(WETH).deposit{value: 2 ether}();
        IERC20(WETH).approve(address(POOL), type(uint256).max);
        IERC20(USDC).approve(address(POOL), type(uint256).max);
        POOL.supply(WETH, 1 ether, user, 0);
        POOL.supply(USDC, 1_000e6, user, 0); // aUSDC collateral, so repayWithATokens burns collateral
        (,, uint256 avail,,,) = POOL.getUserAccountData(user);
        POOL.borrow(USDC, avail * 97 / 100 * 1e6 / ORACLE.getAssetPrice(USDC), 2, 0, user);
        vm.stopPrank();
    }

    function hf() internal view returns (uint256 h) {
        (,,,,, h) = POOL.getUserAccountData(user);
    }

    // Moves the WETH price down until the health factor lands in [lo, hi).
    function crashInto(uint256 lo, uint256 hi) internal {
        uint256 p = ORACLE.getAssetPrice(WETH);
        for (uint256 pct = 100; pct > 0; pct--) {
            vm.mockCall(address(ORACLE), abi.encodeCall(IOracle.getAssetPrice, (WETH)), abi.encode(p * pct / 100));
            uint256 h = hf();
            if (h >= lo && h < hi) return;
        }
        revert("band not reached");
    }

    // Runs every allowed action from the same state. The claim: each one either raises HF or reverts.
    // Maths says repayWithATokens would lower HF below the asset's liquidation threshold; on this
    // deployment Aave itself reverts it there (HealthFactorLowerThanLiquidationThreshold).
    function runAll(string memory state) internal {
        uint256 before = hf();
        console2.log(state, "HF before (1e18):", before);
        uint256 snap = vm.snapshot();

        string[5] memory names = ["supply WETH", "supply USDC", "repay USDC (wallet)", "repayWithATokens USDC", "approve Pool"];
        for (uint256 i; i < 5; i++) {
            vm.prank(user);
            bool ok;
            if (i == 0) (ok,) = address(POOL).call(abi.encodeCall(IPool.supply, (WETH, 0.1 ether, user, 0)));
            if (i == 1) (ok,) = address(POOL).call(abi.encodeCall(IPool.supply, (USDC, 100e6, user, 0)));
            if (i == 2) (ok,) = address(POOL).call(abi.encodeCall(IPool.repay, (USDC, 100e6, 2, user)));
            if (i == 3) (ok,) = address(POOL).call(abi.encodeCall(IPool.repayWithATokens, (USDC, 100e6, 2)));
            if (i == 4) (ok,) = USDC.call(abi.encodeCall(IERC20.approve, (address(POOL), 50e6)));
            uint256 afterHf = hf();
            console2.log(names[i], !ok ? "  reverts" : afterHf >= before ? "  holds  " : "  LOWERS ", afterHf);
            assertTrue(!ok || afterHf >= before, names[i]);
            vm.revertTo(snap);
        }
    }

    function test_healthy() public {
        console2.log("USDC liquidation threshold (1e18):", ltUsdc);
        runAll("healthy");
    }

    function test_liquidatable_above_lt() public {
        crashInto(ltUsdc, 1e18);
        runAll("HF in [LT, 1)");
    }

    function test_liquidatable_below_lt() public {
        crashInto(ltUsdc / 2, ltUsdc);
        runAll("HF < LT");
    }
}
