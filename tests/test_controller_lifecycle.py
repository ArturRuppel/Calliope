from test_editor import page, server


def test_disconnected_controller_releases_original_held_action(page):
    calls = page.evaluate('''async () => {
      const {Controller} = await import('/editor/inputs.js');
      const button = {pressed: true, value: 1};
      let pads = [{index: 0, id: 'First', buttons: [button]}];
      navigator.getGamepads = () => pads;
      const calls = [];
      const bindings = {'pad:0': 'penhold:erase'};
      const controller = new Controller({run: (...args) => calls.push(args), bindings, save: () => {}});
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      controller.startPolling();
      await frame();
      bindings['pad:0'] = 'penhold:pan';
      pads = [];
      await frame();
      return calls;
    }''')
    assert calls == [['penhold:erase', 'down'], ['penhold:erase', 'up']]


def test_disconnect_releases_only_removed_controller(page):
    calls = page.evaluate('''async () => {
      const {Controller} = await import('/editor/inputs.js');
      const pressed = () => ({pressed: true, value: 1});
      let pads = [
        {index: 0, id: 'First', buttons: [pressed(), {pressed: false, value: 0}]},
        {index: 1, id: 'Second', buttons: [{pressed: false, value: 0}, pressed()]},
      ];
      navigator.getGamepads = () => pads;
      const calls = [];
      const controller = new Controller({
        run: (...args) => calls.push(args),
        bindings: {'pad:0': 'penhold:erase', 'pad:1': 'penhold:erase'},
        save: () => {},
      });
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      controller.startPolling();
      await frame();
      pads = [pads[1]];
      const event = new Event('gamepaddisconnected');
      Object.defineProperty(event, 'gamepad', {value: {index: 0}});
      window.dispatchEvent(event);
      await frame();
      pads[0].buttons[1] = {pressed: false, value: 0};
      await frame();
      return calls;
    }''')
    assert calls == [
        ['penhold:erase', 'down'],
        ['penhold:erase', 'up'],
    ]


def test_blur_does_not_reactivate_still_held_controller_button(page):
    calls = page.evaluate('''async () => {
      const {Controller} = await import('/editor/inputs.js');
      const button = {pressed: true, value: 1};
      const pad = {index: 0, id: 'First', buttons: [button]};
      navigator.getGamepads = () => [pad];
      const calls = [];
      const controller = new Controller({
        run: (...args) => calls.push(args),
        bindings: {'pad:0': 'penhold:erase'},
        save: () => {},
      });
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      controller.startPolling();
      await frame();
      window.dispatchEvent(new Event('blur'));
      await frame();
      window.dispatchEvent(new Event('focus'));
      button.pressed = false; button.value = 0;
      await frame();
      button.pressed = true; button.value = 1;
      await frame();
      return calls;
    }''')
    assert calls == [
        ['penhold:erase', 'down'],
        ['penhold:erase', 'up'],
        ['penhold:erase', 'down'],
    ]


def test_controller_press_after_blur_waits_for_release(page):
    calls = page.evaluate('''async () => {
      const {Controller} = await import('/editor/inputs.js');
      const button = {pressed: false, value: 0};
      const pad = {index: 0, id: 'First', buttons: [button]};
      navigator.getGamepads = () => [pad];
      const calls = [];
      const controller = new Controller({
        run: (...args) => calls.push(args),
        bindings: {'pad:0': 'penhold:erase'},
        save: () => {},
      });
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      controller.startPolling();
      await frame();
      window.dispatchEvent(new Event('blur'));
      button.pressed = true; button.value = 1;
      await frame();
      window.dispatchEvent(new Event('focus'));
      await frame();
      button.pressed = false; button.value = 0;
      await frame();
      button.pressed = true; button.value = 1;
      await frame();
      return calls;
    }''')
    assert calls == [['penhold:erase', 'down']]
