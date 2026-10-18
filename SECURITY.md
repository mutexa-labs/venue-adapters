# Security

## Reporting a problem

Please report security problems privately through GitHub's private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for
anything that could put users or their funds at risk.

Include what you found, how to reproduce it, and the version or commit you tested. You will get an answer in
the advisory thread, and a fix is released with a changelog entry that credits you unless you ask otherwise.

## Scope

This package is read-only: it never signs, sends or funds anything, and it never needs a private key. Reports
about wrong liquidation prices, wrong risk parameters, unsafe request handling or data that should not be
committed (keys, addresses of real accounts) are all in scope.
