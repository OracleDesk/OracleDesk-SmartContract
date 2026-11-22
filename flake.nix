{
  description = "Hermetic OracleDesk SmartContract development environment (#135)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Pinned versions synchronized with `oracledesk-stellar/toolchain.env`.
        rustVersion = "1.93.1";
        stellarCliVersion = "27.1.0";

        rustToolchain = pkgs.rust-bin.stable.${rustVersion}.default.override {
          targets = [ "wasm32v1-none" ];
          extensions = [ "rustfmt" "clippy" ];
        };

        stellarSources = {
          "x86_64-linux" = {
            triple = "x86_64-unknown-linux-gnu";
            sha256 = "9915fe63753d7154c26bb9e6410cf1d1ff9727a9b378e663c2790ab7a266af94";
          };
          "aarch64-linux" = {
            triple = "aarch64-unknown-linux-gnu";
            sha256 = "750a8dcda225fab33c87fa0d0dc79936266ed62cd316245fba234f18aab385bd";
          };
        };

        stellarCli =
          if builtins.hasAttr system stellarSources then
            let
              srcInfo = stellarSources.${system};
            in
            pkgs.stdenv.mkDerivation {
              pname = "stellar-cli";
              version = stellarCliVersion;
              src = pkgs.fetchurl {
                url = "https://github.com/stellar/stellar-cli/releases/download/v${stellarCliVersion}/stellar-cli-${stellarCliVersion}-${srcInfo.triple}.tar.gz";
                sha256 = srcInfo.sha256;
              };
              nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
              buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
                pkgs.stdenv.cc.cc.lib
                pkgs.dbus
                pkgs.systemd
                pkgs.openssl
              ];
              sourceRoot = ".";
              installPhase = ''
                mkdir -p $out/bin
                cp stellar $out/bin/stellar
                chmod +x $out/bin/stellar
              '';
            }
          else
            pkgs.stellar-cli;
      in
      {
        devShells.default = pkgs.mkShell {
          name = "oracledesk-dev";
          packages = [
            rustToolchain
            stellarCli
            pkgs.nodejs_24
            pkgs.python312
            pkgs.jq
            pkgs.shellcheck
            pkgs.bashInteractive
            pkgs.gnumake
            pkgs.git
          ];

          shellHook = ''
            echo "OracleDesk hermetic dev shell (Rust ${rustVersion}, stellar-cli ${stellarCliVersion})"
          '';
        };
      }
    );
}
