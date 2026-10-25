#pragma once
// REST API, Server-Sent Events and the website. Contract: docs/API.md.

#include <cstdint>

class Lights;

void apiBegin(Lights& lights);
void apiPoll(uint32_t now);   // pushes state to SSE clients after changes and as a heartbeat
