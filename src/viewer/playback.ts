import { AnimationMixer, type AnimationAction, type AnimationClip, type Object3D } from "three";

export function createPlayback(root: Object3D, onChange: (time: number, playing: boolean) => void) {
  const mixer = new AnimationMixer(root);
  let action: AnimationAction | undefined;
  let previousFrame: number | undefined;
  let playing = false;
  let loop = true;

  function seek(time: number) {
    if (!action) return;
    // 固定动作时间后重新采样，拖动到最后一帧时也能保留该姿势
    action.time = Math.min(action.getClip().duration, Math.max(0, time));
    mixer.update(0);
    onChange(action.time, playing);
  }

  return {
    select(clip: AnimationClip) {
      mixer.stopAllAction();
      playing = false;
      previousFrame = undefined;
      action = mixer.clipAction(clip).reset().play();
      action.paused = true;
      seek(0);
    },
    setLoop(value: boolean) { loop = value; },
    setPlaying(value: boolean) {
      if (!action || action.getClip().duration <= 0) return;
      playing = value;
      previousFrame = undefined;
      seek(playing && action.time >= action.getClip().duration ? 0 : action.time);
    },
    seek,
    update(timestamp: number) {
      if (!playing || !action) return false;
      const duration = action.getClip().duration;
      const time = action.time + Math.min(0.1, (timestamp - (previousFrame ?? timestamp)) / 1000);
      previousFrame = timestamp;
      if (!loop && time >= duration) playing = false;
      seek(loop ? time % duration : time);
      return playing;
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
