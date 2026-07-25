// native-only: there's no Arduino core here to call setup()/loop() for us, so this
// provides the desktop main() — LovyanGFX's own SDL event-loop wrapper around our
// setup()/loop(). Excluded from the esp32-s3 build (platformio.ini's
// build_src_filter) since the Arduino framework supplies its own main() there and
// a second one would fail to link. Copied verbatim from LovyanGFX's own
// examples_for_PC/PlatformIO_SDL/src/sdl_main.cpp — no reason to deviate from a
// working reference for boilerplate this small.
#include <lgfx/v1/platforms/sdl/Panel_sdl.hpp>
#if defined(SDL_h_)

void setup(void);
void loop(void);

__attribute__((weak)) int user_func(bool *running)
{
  setup();
  do
  {
    loop();
  } while (*running);
  return 0;
}

int main(int, char **)
{
  return lgfx::Panel_sdl::main(user_func);
}

#endif
