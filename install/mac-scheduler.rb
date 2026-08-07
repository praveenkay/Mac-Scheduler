cask "mac-scheduler" do
  version "1.0.0"
  sha256 arm:   "ARM64_SHA256",
         intel: "X86_64_SHA256"

  url "https://github.com/praveenkay/Mac-Scheduler/releases/download/v#{version}/MacScheduler-#{version}-#{Hardware::CPU.arch == :arm64 ? "arm64" : "x86_64"}.dmg"
  name "Mac Scheduler"
  desc "Control center for all scheduled tasks on macOS — launchd agents, daemons, and cron, with full CRUD"
  homepage "https://github.com/praveenkay/Mac-Scheduler"

  app "Mac Scheduler.app"

  postflight do
    system_command "/bin/sh",
                   args: ["-lc", "/bin/zsh \"#{staged_path}/Mac Scheduler.app/Contents/Resources/install/install-permissions.sh\" on"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Logs/MacScheduler",
    "/tmp/macscheduler-keepalive.log",
  ]
end
