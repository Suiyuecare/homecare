import { mountPublicSurvey } from '../modules/public-survey.js';

const container = document.querySelector('#main-content');
let generation = 0;
function render() {
  const started = ++generation;
  mountPublicSurvey(container, { isCurrent: () => started === generation });
}
window.addEventListener('hashchange', render);
render();
