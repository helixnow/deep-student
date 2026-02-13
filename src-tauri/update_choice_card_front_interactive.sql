-- ===========================================
-- 更新 choice-card 前面模板以支持交互答题
-- 使用简单自包含脚本以便在 Anki/SQLite 中直接执行
-- ===========================================

UPDATE custom_anki_templates
SET 
  front_template = '<div class="card choice-card">
  <div class="question-section">
    <div class="question-label">📝 题目</div>
    <div class="question-text">{{Front}}</div>
  </div>
  
  <div class="options-section">
    <div class="option" data-option="A">
      <span class="option-label">A</span>
      <span class="option-text">{{optiona}}</span>
    </div>
    <div class="option" data-option="B">
      <span class="option-label">B</span>
      <span class="option-text">{{optionb}}</span>
    </div>
    <div class="option" data-option="C">
      <span class="option-label">C</span>
      <span class="option-text">{{optionc}}</span>
    </div>
    <div class="option" data-option="D">
      <span class="option-label">D</span>
      <span class="option-text">{{optiond}}</span>
    </div>
  </div>

  <div class="answer-section" style="display:none;">
    <div class="answer-label">✅ 正确答案：{{correct}}</div>
  </div>
  
  {{#explanation}}
  <div class="explanation-section" style="display:none;">
    <div class="explanation-label">💡 解析</div>
    <div class="explanation-text">{{explanation}}</div>
  </div>
  {{/explanation}}

  <div class="instruction">请选择一个答案</div>

  <script>
    (function () {
      var options = document.querySelectorAll(".option");
      var answerSection = document.querySelector(".answer-section");
      var explanationSection = document.querySelector(".explanation-section");
      var correct = "{{correct}}".trim().toUpperCase().replace(/[^A-Z]/g, "");
      if (!correct) { correct = "A"; }
      var correctSet = correct.split("");
      var isMultiple = correctSet.length > 1;
      var instruction = document.querySelector(".instruction");
      if (instruction) { instruction.textContent = isMultiple ? "请选择所有正确答案（可多选）" : "请选择一个答案"; }
      options.forEach(function (opt) {
        opt.addEventListener("click", function () {
          if (opt.classList.contains("answered")) { return; }
          var letter = opt.getAttribute("data-option");
          if (isMultiple) {
            opt.classList.toggle("selected");
            var selectedNodes = document.querySelectorAll(".option.selected");
            if (!selectedNodes.length) { return; }
            var selectedLetters = [];
            selectedNodes.forEach(function (node) {
              selectedLetters.push(node.getAttribute("data-option"));
            });
            var hasWrong = selectedLetters.some(function (item) { return correctSet.indexOf(item) === -1; });
            var complete = selectedLetters.length === correctSet.length;
            if (!hasWrong && !complete) { return; }
            options.forEach(function (node) { node.classList.add("answered"); });
            correctSet.forEach(function (item) {
              var target = document.querySelector(".option[data-option='" + item + "']");
              if (target) { target.classList.add("correct"); }
            });
            selectedLetters.forEach(function (item) {
              if (correctSet.indexOf(item) === -1) {
                var wrong = document.querySelector(".option[data-option='" + item + "']");
                if (wrong) { wrong.classList.add("incorrect"); }
              }
            });
          } else {
            options.forEach(function (node) { node.classList.remove("selected", "correct", "incorrect", "answered"); });
            opt.classList.add("selected", "answered");
            if (correctSet.indexOf(letter) !== -1) {
              opt.classList.add("correct");
            } else {
              opt.classList.add("incorrect");
              correctSet.forEach(function (item) {
                var correctOpt = document.querySelector(".option[data-option='" + item + "']");
                if (correctOpt) { correctOpt.classList.add("correct"); }
              });
            }
          }
          if (answerSection) { answerSection.style.display = "block"; }
          if (explanationSection) { explanationSection.style.display = "block"; }
          if (instruction) { instruction.style.display = "none"; }
        });
      });
    })();
  </script>
</div>',
  -- 追加 CSS: 新增 selected/incorrect 状态
  css_style = css_style || '' || '

.option.incorrect {
  background: #fee2e2;
  border-color: #ef4444;
}
.option.incorrect .option-label {
  background: #ef4444;
  color: #ffffff;
}
.option.selected {
  box-shadow: 0 0 0 2px #3b82f6 inset;
}
'
WHERE id = 'choice-card';

UPDATE custom_anki_templates SET version = '1.0.16' WHERE id = 'choice-card';

-- 提示：执行后请刷新应用缓存或重新加载模板管理器以查看效果 