#define DISCORDPP_IMPLEMENTATION
#include "discordpp.h"
#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <queue>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <memory>

// Only the parent companion writes stdin. Text fields are base64, never commands or paths.
std::string decode(const std::string& input) {
    if (input == "-") return {};
    static const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result; unsigned int bits = 0; int count = 0;
    for (unsigned char c : input) { if (c == '=') break; const auto n = alphabet.find(c); if (n == std::string::npos) throw std::runtime_error("base64"); bits = (bits << 6) | static_cast<unsigned int>(n); count += 6; if (count >= 8) { count -= 8; result.push_back(static_cast<char>((bits >> count) & 255)); } }
    return result;
}
int main(int argc, char** argv) {
    if (argc != 3 || !std::regex_match(argv[1], std::regex("[0-9]{17,20}"))) return 2;
    const uint64_t appId = std::stoull(argv[1]);
    auto client = std::make_shared<discordpp::Client>();
    // Register before any RPC activity/authentication, including a cold launch.
    client->SetActivityJoinCallback([](std::string secret) { if (std::regex_match(secret, std::regex("[A-Za-z0-9_-]{43}"))) std::cout << "JOIN\t" << secret << std::endl; });
    client->SetApplicationId(appId);
    if (!client->RegisterLaunchCommand(appId, argv[2])) { std::cout << "STATUS\terror" << std::endl; }
    std::cout << "STATUS\tready" << std::endl;
    std::mutex mutex; std::queue<std::string> commands; std::atomic<bool> reading{true};
    std::thread reader([&] { std::string line; while (std::getline(std::cin, line)) { if (line == "STOP") break; if (line.size() > 16384) continue; std::lock_guard<std::mutex> lock(mutex); if (commands.size() < 32) commands.push(line); } reading = false; });
    bool running = true;
    while (running && reading) {
        discordpp::RunCallbacks();
        std::string line; { std::lock_guard<std::mutex> lock(mutex); if (!commands.empty()) { line = commands.front(); commands.pop(); } }
        if (line == "STOP") running = false;
        else if (line == "CLEAR") client->ClearRichPresence();
        else if (!line.empty()) {
            try {
                std::istringstream input(line); std::string command, type, title, artist, cover, state, room, secret, url; int size, max; int64_t start, end;
                if (!(input >> command >> type >> title >> artist >> cover >> state >> room >> size >> max >> start >> end >> secret >> url) || command != "PRESENCE" || size < 1 || size > max || max > 256) continue;
                discordpp::Activity activity;
                const bool listening = type == "listening";
                activity.SetType(listening ? discordpp::ActivityTypes::Listening : discordpp::ActivityTypes::Playing);
                activity.SetName("PulseParty · Яндекс Музыка");
                activity.SetDetails(decode(title)); activity.SetState(decode(artist) + " · " + decode(state));
                discordpp::ActivityAssets assets; if (cover != "-") assets.SetLargeImage(decode(cover)); assets.SetLargeText(decode(title)); activity.SetAssets(assets);
                if (start > 0) { discordpp::ActivityTimestamps timestamps; timestamps.SetStart(start); timestamps.SetEnd(end); activity.SetTimestamps(timestamps); }
                discordpp::ActivityParty party; party.SetId(decode(room)); party.SetCurrentSize(size); party.SetMaxSize(max); activity.SetParty(party);
                if (secret != "-" && size < max) { discordpp::ActivitySecrets secrets; secrets.SetJoin(decode(secret)); activity.SetSecrets(secrets); activity.SetSupportedPlatforms(discordpp::ActivityGamePlatforms::Desktop); }
                if (url != "-") { discordpp::ActivityButton button; button.SetLabel("Открыть PulseParty"); button.SetUrl(decode(url)); activity.AddButton(button); }
                client->UpdateRichPresence(activity, [listening](discordpp::ClientResult result) { std::cout << "STATUS\t" << (result.Successful() ? (listening ? "listening" : "playing") : "error") << std::endl; });
            } catch (...) { std::cout << "STATUS\terror" << std::endl; }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    client->ClearRichPresence();
    // Parent closes stdin on shutdown; do not leave a blocked input thread.
    if (reader.joinable()) reader.join();
    return 0;
}
