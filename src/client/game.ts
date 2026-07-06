import * as Phaser from 'phaser';
import { AUTO, Game as PhaserGame } from 'phaser';
import { Game } from './scenes/Game';
import { Hud } from './hud';

const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  transparent: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 400,
    height: 720,
  },
  scene: [Game],
};

document.addEventListener('DOMContentLoaded', () => {
  const hud = new Hud();
  const game = new PhaserGame(config);
  game.registry.set('hud', hud);
});
