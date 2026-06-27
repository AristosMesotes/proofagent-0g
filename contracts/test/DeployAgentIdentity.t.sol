// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.26;

import {DeployAgentIdentity} from "../script/DeployAgentIdentity.s.sol";

/// @title DeployAgentIdentityTest -- the chain-guard invariant for the Agentic-ID deploy script (no forge-std).
/// @notice The script must REFUSE to broadcast against any non-0G chain (design SS8, the on-chain half). The
///         pure {requireOgChain} is the unit-testable core; the full run() needs env + broadcast (integration).
contract DeployAgentIdentityTest {
    DeployAgentIdentity internal dep;

    function setUp() public {
        dep = new DeployAgentIdentity();
    }

    function _t(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    function testGuardAcceptsOgChains() public view {
        dep.requireOgChain(16602); // Galileo testnet
        dep.requireOgChain(16661); // Aristotle mainnet
    }

    function testGuardRejectsNon0gChains() public {
        (bool okEth,) = address(dep).call(abi.encodeWithSelector(dep.requireOgChain.selector, uint256(1)));
        _t(!okEth, "Ethereum mainnet must revert");
        (bool okBase,) = address(dep).call(abi.encodeWithSelector(dep.requireOgChain.selector, uint256(8453)));
        _t(!okBase, "Base must revert");
    }
}
