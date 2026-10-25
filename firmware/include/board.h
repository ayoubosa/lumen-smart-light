#pragma once
// Hardware-facing pieces: outputs, sensors and the settings kept in flash.

#include <cstdint>

class Lights;

void outputsBegin();
void outputWrite(uint8_t room, uint8_t brightness);   // matches Lights::Output

void sensorsBegin();
void sensorsPoll(Lights& lights, uint32_t now);

void settingsBegin(Lights& lights);
void settingsPoll(const Lights& lights);              // writes only when something changed
