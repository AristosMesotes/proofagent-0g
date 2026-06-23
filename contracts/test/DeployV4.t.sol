// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {DeployV4} from "../script/DeployV4.s.sol";

/// @title DeployV4Test -- dependency-free tests for the {DeployV4} script's target-chain guard.
/// @notice Proves the consolidated-mandate deploy script is BUILT and SOUND -- specifically its
///         load-bearing safety invariant, the 0G-only target-chain guard (the on-chain half of design SS8:
///         "testnet/dev only for live legs") -- without performing any live deploy (claim only what's live).
contract DeployV4Test {
    DeployV4 internal script;

    uint256 internal constant OG_MAINNET = 16661; // 0G Aristotle
    uint256 internal constant OG_TESTNET = 16602; // 0G Galileo

    function setUp() public {
        script = new DeployV4();
    }

    function _assertTrue(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function test_ChainGuard_AcceptsOgMainnet() public view {
        script.requireOgChain(OG_MAINNET); // must not revert
    }

    function test_ChainGuard_AcceptsOgTestnet() public view {
        script.requireOgChain(OG_TESTNET); // must not revert
    }

    function test_ChainGuard_RejectsForeignChain() public view {
        (bool ok, bytes memory data) = address(script)
            .staticcall(abi.encodeWithSelector(DeployV4.requireOgChain.selector, uint256(31337)));
        _assertTrue(!ok, "requireOgChain must revert for a non-0G chain id");
        bytes4 sel = bytes4(keccak256("WrongChain(uint256)"));
        _assertTrue(data.length == 4 + 32, "revert payload must be WrongChain(uint256)");
        bytes4 got;
        uint256 actual;
        assembly {
            got := mload(add(data, 0x20))
            actual := mload(add(data, 0x24))
        }
        _assertTrue(got == sel, "revert selector must be WrongChain(uint256)");
        _assertTrue(actual == 31337, "WrongChain must carry the offending chain id");
    }

    function test_ChainGuard_RejectsZeroChain() public view {
        (bool ok,) =
            address(script).staticcall(abi.encodeWithSelector(DeployV4.requireOgChain.selector, uint256(0)));
        _assertTrue(!ok, "requireOgChain must reject chain id 0");
    }
}
