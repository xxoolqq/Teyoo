// 工具栏 DOM：原样搬运自官方 demo（Hufe921/canvas-editor 根目录 index.html）。
// 官方用的是 id（color/highlight/image/option-*）；这里换成 class —— 一个标签页
// 一份工具栏，重复 id 会互相串台。代码块（依赖 prismjs）与全屏两项已移除。
export const MENU_HTML = `    <div class="menu">
      <div class="menu-item">
        <div class="menu-item__undo">
          <i></i>
        </div>
        <div class="menu-item__redo">
          <i></i>
        </div>
        <div class="menu-item__painter" title="格式刷(双击可连续使用)">
          <i></i>
        </div>
        <div class="menu-item__format" title="清除格式">
          <i></i>
        </div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item">
        <div class="menu-item__font">
          <span class="select" title="字体">微软雅黑</span>
          <div class="options">
            <ul>
              <li data-family="Microsoft YaHei" style="font-family:'Microsoft YaHei';">微软雅黑</li>
              <li data-family="华文宋体" style="font-family:'华文宋体';">华文宋体</li>
              <li data-family="华文黑体" style="font-family:'华文黑体';">华文黑体</li>
              <li data-family="华文仿宋" style="font-family:'华文仿宋';">华文仿宋</li>
              <li data-family="华文楷体" style="font-family:'华文楷体';">华文楷体</li>
              <li data-family="华文琥珀" style="font-family:'华文琥珀';">华文琥珀</li>
              <li data-family="华文楷体" style="font-family:'华文楷体';">华文楷体</li>
              <li data-family="华文隶书" style="font-family:'华文隶书';">华文隶书</li>
              <li data-family="华文新魏" style="font-family:'华文新魏';">华文新魏</li>
              <li data-family="华文行楷" style="font-family:'华文行楷';">华文行楷</li>
              <li data-family="华文中宋" style="font-family:'华文中宋';">华文中宋</li>
              <li data-family="华文彩云" style="font-family:'华文彩云';">华文彩云</li>
              <li data-family="Arial" style="font-family:'Arial';">Arial</li>
              <li data-family="Segoe UI" style="font-family:'Segoe UI';">Segoe UI</li>
              <li data-family="Ink Free" style="font-family:'Ink Free';">Ink Free</li>
              <li data-family="Fantasy" style="font-family:'Fantasy';">Fantasy</li>
            </ul>
          </div>
        </div>
        <div class="menu-item__size">
          <span class="select" title="字体">小四</span>
          <div class="options">
            <ul>
              <li data-size="56">初号</li>
              <li data-size="48">小初</li>
              <li data-size="34">一号</li>
              <li data-size="32">小一</li>
              <li data-size="29">二号</li>
              <li data-size="24">小二</li>
              <li data-size="21">三号</li>
              <li data-size="20">小三</li>
              <li data-size="18">四号</li>
              <li data-size="16">小四</li>
              <li data-size="14">五号</li>
              <li data-size="12">小五</li>
              <li data-size="10">六号</li>
              <li data-size="8">小六</li>
              <li data-size="7">七号</li>
              <li data-size="6">八号</li>
            </ul>
          </div>
        </div>
        <div class="menu-item__size-add">
          <i></i>
        </div>
        <div class="menu-item__size-minus">
          <i></i>
        </div>
        <div class="menu-item__bold">
          <i></i>
        </div>
        <div class="menu-item__italic">
          <i></i>
        </div>
        <div class="menu-item__underline">
          <i></i>
          <span class="select"></span>
          <div class="options">
            <ul>
              <li data-decoration-style='solid'>
                <i></i>
              </li>
              <li data-decoration-style='double'>
                <i></i>
              </li>
              <li data-decoration-style='dashed'>
                <i></i>
              </li>
              <li data-decoration-style='dotted'>
                <i></i>
              </li>
              <li data-decoration-style='wavy'>
                <i></i>
              </li>
            </ul>
          </div>
        </div>
        <div class="menu-item__strikeout" title="删除线(Ctrl+Shift+X)">
          <i></i>
        </div>
        <div class="menu-item__superscript">
          <i></i>
        </div>
        <div class="menu-item__subscript">
          <i></i>
        </div>
        <div class="menu-item__color" title="字体颜色">
          <i></i>
          <span></span>
          <input type="color" class="color-input" />
        </div>
        <div class="menu-item__highlight" title="高亮">
          <i></i>
          <span></span>
          <input type="color" class="highlight-input">
        </div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item">
        <div class="menu-item__title">
          <i></i>
          <span class="select" title="切换标题">正文</span>
          <div class="options">
            <ul>
              <li style="font-size:16px;">正文</li>
              <li data-level="first" style="font-size:26px;">标题1</li>
              <li data-level="second" style="font-size:24px;">标题2</li>
              <li data-level="third" style="font-size:22px;">标题3</li>
              <li data-level="fourth" style="font-size:20px;">标题4</li>
              <li data-level="fifth" style="font-size:18px;">标题5</li>
              <li data-level="sixth" style="font-size:16px;">标题6</li>
            </ul>
          </div>
        </div>
        <div class="menu-item__left">
          <i></i>
        </div>
        <div class="menu-item__center">
          <i></i>
        </div>
        <div class="menu-item__right">
          <i></i>
        </div>
        <div class="menu-item__alignment">
          <i></i>
        </div>
        <div class="menu-item__justify">
          <i></i>
        </div>
        <div class="menu-item__row-margin">
          <i title="行间距"></i>
          <div class="options">
            <ul>
              <li data-rowmargin='1'>1</li>
              <li data-rowmargin="1.25">1.25</li>
              <li data-rowmargin="1.5">1.5</li>
              <li data-rowmargin="1.75">1.75</li>
              <li data-rowmargin="2">2</li>
              <li data-rowmargin="2.5">2.5</li>
              <li data-rowmargin="3">3</li>
            </ul>
          </div>
        </div>
        <div class="menu-item__list">
          <i></i>
          <div class="options">
            <ul>
              <li>
                <label>取消列表</label>
              </li>
              <li data-list-type="ol" data-list-style='decimal'>
                <label>有序列表：</label>
                <ol>
                  <li>________</li>
                </ol>
              </li>
              <li data-list-type="ul" data-list-style='checkbox'>
                <label>复选框列表：</label>
                <ul style="list-style-type: '☑️ ';">
                  <li>________</li>
                </ul>
              </li>
              <li data-list-type="ul" data-list-style='disc'>
                <label>实心圆点列表：</label>
                <ul style="list-style-type: disc;">
                  <li>________</li>
                </ul>
              </li>
              <li data-list-type="ul" data-list-style='circle'>
                <label>空心圆点列表：</label>
                <ul style="list-style-type: circle;">
                  <li>________</li>
                </ul>
              </li>
              <li data-list-type="ul" data-list-style='square'>
                <label>空心方块列表：</label>
                <ul style="list-style-type: '☐ ';">
                  <li>________</li>
                </ul>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item">
        <div class="menu-item__table">
          <i title="表格"></i>
        </div>
        <div class="menu-item__table__collapse">
          <div class="table-close">×</div>
          <div class="table-title">
            <span class="table-select">插入</span>
            <span>表格</span>
          </div>
          <div class="table-panel"></div>
        </div>
        <div class="menu-item__image">
          <i title="图片"></i>
          <input type="file" class="image-input" accept=".png, .jpg, .jpeg, .svg, .gif">
        </div>
        <div class="menu-item__hyperlink">
          <i title="超链接"></i>
        </div>
        <div class="menu-item__separator">
          <i title="分割线"></i>
          <div class="options">
            <ul>
              <li data-separator='0,0'>
                <i></i>
              </li>
              <li data-separator="1,1">
                <i></i>
              </li>
              <li data-separator="3,1">
                <i></i>
              </li>
              <li data-separator="4,4">
                <i></i>
              </li>
              <li data-separator="7,3,3,3">
                <i></i>
              </li>
              <li data-separator="6,2,2,2,2,2">
                <i></i>
              </li>
            </ul>
          </div>
        </div>
        <div class="menu-item__watermark">
          <i title="水印(添加、删除)"></i>
          <div class="options">
            <ul>
              <li data-menu="add">添加水印</li>
              <li data-menu="delete">删除水印</li>
            </ul>
          </div>
        </div>
        <div class="menu-item__page-break" title="分页符">
          <i></i>
        </div>
        <div class="menu-item__control">
          <i title="控件"></i>
          <div class="options">
            <ul>
              <li data-control='text'>文本</li>
              <li data-control="number">数值</li>
              <li data-control="select">列举</li>
              <li data-control="date">日期</li>
              <li data-control="checkbox">复选框</li>
              <li data-control="radio">单选框</li>
            </ul>
          </div>
        </div>
        <div class="menu-item__checkbox" title="复选框">
          <i></i>
        </div>
        <div class="menu-item__radio" title="单选框">
          <i></i>
        </div>
        <div class="menu-item__latex" title="LateX">
          <i></i>
        </div>
        <div class="menu-item__date">
          <i title="日期"></i>
          <div class="options">
            <ul>
              <li data-format="yyyy-MM-dd"></li>
              <li data-format="yyyy-MM-dd hh:mm:ss"></li>
            </ul>
          </div>
        </div>
        <div class="menu-item__block" title="内容块">
          <i></i>
        </div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item">
        <div class="menu-item__search" data-menu="search">
          <i></i>
        </div>
        <div class="menu-item__search__collapse" data-menu="search">
          <div class="menu-item__search__collapse__search">
            <input type="text" />
            <label class="search-result"></label>
            <div class="arrow-left">
              <i></i>
            </div>
            <div class="arrow-right">
              <i></i>
            </div>
            <span>×</span>
          </div>
          <div class="menu-item__search__collapse__replace">
            <input type="text">
            <button>替换</button>
          </div>
          <div class="menu-item__search__collapse__option">
            <div class="search-option-item">
              <input type="checkbox" class="option-reg" checked />
              <label>正则</label>
            </div>
            <div class="search-option-item">
              <input type="checkbox" class="option-case" checked />
              <label>忽略大小写</label>
            </div>
            <div class="search-option-item">
              <input type="checkbox" class="option-selection" />
              <label>选定内容内查找</label>
            </div>
          </div>
        </div>
        <div class="menu-item__print" data-menu="print">
          <i></i>
        </div>
        <!-- 导入导出：官方 demo 只有「导出」，这里借同一个下拉把我们自己的
             JSON 互转也挂进来（见 canvas-editor/markdown/）。
             已停用：导入 Markdown（用户要求撤下）。底层都保留未删 ——
             importMarkdownIntoNewTab（toolbar/io.ts）与这里的 li 一起取消注释
             即可恢复，menu.ts 里对应的分支也要一并放开。 -->
        <div class="menu-item__export" title="导入导出">
          <i></i>
          <div class="options">
            <ul>
              <!-- <li data-export="import-md">导入 Markdown</li> -->
              <li data-export="import-json">导入 JSON</li>
              <li data-export="export-md">导出 Markdown</li>
              <li data-export="json">导出 JSON</li>
              <li data-export="pdf">打印 / 导出 PDF</li>
            </ul>
          </div>
        </div>
        <!-- 插入：官方插件的「特殊字符」面板（原来这里是 Word 工具，没接） -->
        <div class="menu-item__insert" title="插入">
          <i></i>
          <div class="options">
            <ul>
              <li data-insert="special-characters">特殊字符…</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
    <div class="catalog">
      <div class="catalog__header">
        <span>目录</span>
        <div class="catalog__header__close">
          <i></i>
        </div>
      </div>
      <div class="catalog__main"></div>
    </div>
    <div class="footer">
      <div>
        <div class="catalog-mode" title="目录">
          <i></i>
        </div>
        <div class="page-mode">
          <i title="页面模式(分页、连页)"></i>
          <div class="options">
            <ul>
              <li data-page-mode="paging" class="active">分页</li>
              <li data-page-mode="continuity">连页</li>
            </ul>
          </div>
        </div>
        <span>可见页码：<span class="page-no-list">1</span></span>
        <span>页面：<span class="page-no">1</span>/<span class="page-size">1</span></span>
        <span>字数：<span class="word-count">0</span></span>
        <span>行：<span class="row-no">0</span></span>
        <span>列：<span class="col-no">0</span></span>
      </div>
      <div class="editor-mode" title="编辑模式(编辑、清洁、只读、表单、设计、涂鸦、留痕)">
        <span class="text">编辑模式</span>
        <ul class="options">
          <li data-mode="edit" class="active">编辑模式</li>
          <li data-mode="clean">清洁模式</li>
          <li data-mode="readonly">只读模式</li>
          <li data-mode="form">表单模式</li>
          <li data-mode="print">打印模式</li>
          <li data-mode="design">设计模式</li>
          <li data-mode="graffiti">涂鸦模式</li>
          <li data-mode="trace" class="trace-mode-item">
            <span class="trace-mode-label">留痕模式</span>
            <label class="trace-toggle" title="勾选后，新增/删除将作为留痕记录；留痕查看模式下不可修改">
              <input type="checkbox" class="trace-toggle__input" />
              <span>记录</span>
            </label>
          </li>
        </ul>
      </div>
      <div>
        <div class="page-scale-minus" title="缩小(Ctrl+-)">
          <i></i>
        </div>
        <span class="page-scale-percentage" title="显示比例(点击可复原Ctrl+0)">100%</span>
        <div class="page-scale-add" title="放大(Ctrl+=)">
          <i></i>
        </div>
        <div class="paper-size">
          <i title="纸张类型"></i>
          <div class="options">
            <ul>
              <li data-paper-size="794*1123" class="active">A4</li>
              <li data-paper-size="1593*2251">A2</li>
              <li data-paper-size="1125*1593">A3</li>
              <li data-paper-size="565*796">A5</li>
              <li data-paper-size="412*488">5号信封</li>
              <li data-paper-size="450*866">6号信封</li>
              <li data-paper-size="609*862">7号信封</li>
              <li data-paper-size="862*1221">9号信封</li>
              <li data-paper-size="813*1266">法律用纸</li>
              <li data-paper-size="813*1054">信纸</li>
            </ul>
          </div>
        </div>
        <div class="paper-direction">
          <i title="纸张方向"></i>
          <div class="options">
            <ul>
              <li data-paper-direction="vertical" class="active">纵向</li>
              <li data-paper-direction="horizontal">横向</li>
              <li class="option-caption">指定页面</li>
              <li data-section-direction="horizontal">本节横向</li>
              <li data-section-direction="vertical">本节纵向</li>
              <li data-section-direction="inherit">跟随全局</li>
            </ul>
          </div>
        </div>
        <div class="paper-margin" title="页边距">
          <i></i>
        </div>
        <div class="column-config" title="分栏">
          <i></i>
        </div>
        <div class="ruler-toggle" title="标尺">
          <i></i>
        </div>
        <div class="spellcheck" title="拼写检查">
          <i></i>
          <div class="options">
            <label class="spellcheck-toggle">
              <input type="checkbox" class="spellcheck-toggle__input" />
              <span>启用拼写检查</span>
            </label>
          </div>
        </div>
        <div class="editor-option" title="编辑器设置">
          <i></i>
        </div>
      </div>
    </div>`
