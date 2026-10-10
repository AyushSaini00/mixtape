class Mixtape < Formula
  desc "Track and analyze your YouTube Music listening habits from the terminal"
  homepage "https://github.com/AyushSaini00/mixtape"
  head "https://github.com/AyushSaini00/mixtape.git", branch: "main"

  depends_on :macos
  depends_on "media-control"
  depends_on "node"

  def install
    system "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"
    system "npm", "run", "build"
    libexec.install "dist", "package.json"

    (bin/"mixtape").write <<~SH
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/main.js" "$@"
    SH
  end

  service do
    run [opt_bin/"mixtape", "daemon"]
    keep_alive true
    process_type :background
    environment_variables PATH: std_service_path_env, MIXTAPE_LOG_FILE: var/"log/mixtape.log"
    log_path var/"log/mixtape.log"
    error_log_path var/"log/mixtape.log"
  end

  def caveats
    <<~EOS
      Start the recorder in the background (and at every login) with:
        brew services start mixtape

      Then listen in the YouTube Music app (Chrome's installed web app) and run:
        mixtape          # today
        mixtape week     # last 7 days
    EOS
  end

  test do
    ENV["MIXTAPE_HOME"] = testpath
    assert_equal version.to_s, shell_output("#{bin}/mixtape --version").strip
    assert_match "Nothing listened to yet", shell_output("#{bin}/mixtape today")
  end
end
