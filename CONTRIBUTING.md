# Contributing

Thanks for helping improve the KugelAudio SDKs.

## How this repository works

This repository is published from the KugelAudio monorepo, where the SDKs are
developed and tested together with the API they call. Every change to the SDK
there is synced here automatically, so the code you see is the code we ship.

- **Issues** are welcome here: bugs, missing features, unclear docs.
- **Pull requests** are welcome too. A maintainer applies your commits to the
  monorepo with your authorship kept, the change goes through our full test
  suite, and the next sync brings it back here. We then close your pull request
  with a link to the sync commit that contains it. That is how your change gets
  merged, even though GitHub shows the pull request as closed rather than merged.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on
   the approach before you spend time on it.
2. Keep a pull request to one change, and add or update tests for it.
3. Run the tests locally. The exact commands are in
   [`.github/workflows/test.yml`](.github/workflows/test.yml), which runs on
   every pull request.

## Security

Please do not report security problems in public issues. Use
**Security > Report a vulnerability** on this repository, or email
hello@kugelaudio.com.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this repository.
